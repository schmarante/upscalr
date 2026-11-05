// The two network structures of the upscaling models, rebuilt as ONNX graphs from the published layer layout.
// Layers are found by the names in the state dict; missing or extra tensors stop the conversion.
//
// compact: a plain stack of 3×3 convolutions with per-channel PReLU at low resolution, the last convolution yields
//          scale² × 3 channels that a depth-to-space step turns into the image; the nearest-upscaled input is added
//          (the network only learns the difference). Small and fast.
// rrdb:    residual-in-residual dense blocks – each block holds three dense blocks of five convolutions whose inputs
//          are all previous feature maps concatenated; residuals are scaled by 0.2. Upscaling by two nearest ×2 steps,
//          each followed by a convolution. Larger, sharper.
//
// I/O of every model: input "input" float32 [1, 3, H, W] RGB in 0…1, output "output" float32 [1, 3, H·s, W·s]
// (not clamped). With FLOAT16 the weights and activations are half floats; input and output stay float32.
import { Graph, Float, FLOAT, FLOAT16, INT64 } from './onnx-writer.mjs';

const LEAKY = new Float(0.2);       // negative slope of every leaky ReLU in the rrdb net
const RESIDUAL = 0.2;               // residual scaling of the dense blocks

function take(sd, used, name) {
    const t = sd.get(name);
    if (!t) throw new Error(`weight missing: ${name}`);
    used.add(name);
    return t;
}

/** 3×3 convolution (padding 1) from `<prefix>.weight` / `<prefix>.bias`; `factor` is folded into the weights */
function conv(g, sd, used, x, prefix, factor = 1) {
    const w = take(sd, used, `${prefix}.weight`), b = take(sd, used, `${prefix}.bias`);
    const [, , kh, kw] = w.shape;
    const scaleData = d => (factor === 1 ? d : d.map(v => v * factor));
    const W = g.constant(w.shape, scaleData(w.data), { name: `${prefix}.weight` });
    const B = g.constant(b.shape, scaleData(b.data), { name: `${prefix}.bias` });
    return g.node('Conv', [x, W, B], { kernel_shape: [kh, kw], pads: [kh >> 1, kw >> 1, kh >> 1, kw >> 1], strides: [1, 1] });
}

/** nearest-neighbour upscaling exactly like the training code (source pixel = floor(target / scale)) */
function nearest(g, x, scale) {
    const scales = g.constant([4], [1, 1, scale, scale], { type: FLOAT });
    return g.node('Resize', [x, '', scales], { mode: 'nearest', coordinate_transformation_mode: 'asymmetric', nearest_mode: 'floor' });
}

function begin(type) {
    const g = new Graph(type);
    const input = g.input('input', FLOAT, [1, 3, 'height', 'width']);
    const x = type === FLOAT16 ? g.node('Cast', [input], { to: FLOAT16 }) : input;
    return { g, input, x };
}

function end(g, y, type) {
    if (type === FLOAT16) g.node('Cast', [y], { to: FLOAT }, 'output');
    else g.node('Identity', [y], {}, 'output');
    g.output('output', FLOAT, [1, 3, 'height_out', 'width_out']);
}

function checkAllUsed(sd, used) {
    const extra = [...sd.keys()].filter(k => !used.has(k));
    if (extra.length) throw new Error(`unexpected weights (structure differs): ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' …' : ''}`);
}

export function buildCompact(sd, scale, type = FLOAT) {
    const used = new Set();
    const { g, input, x: start } = begin(type);
    const layers = [...new Set([...sd.keys()].map(k => k.match(/^body\.(\d+)\./)?.[1]).filter(Boolean).map(Number))].sort((a, b) => a - b);
    if (!layers.length) throw new Error('compact net: no body.N layers');
    let x = start, lastOut = 0;
    for (const i of layers) {
        const prefix = `body.${i}`;
        if (sd.has(`${prefix}.bias`)) {
            x = conv(g, sd, used, x, prefix);
            lastOut = sd.get(`${prefix}.weight`).shape[0];
        } else {
            const slope = take(sd, used, `${prefix}.weight`);
            x = g.node('PRelu', [x, g.constant([slope.shape[0], 1, 1], slope.data, { name: `${prefix}.weight` })]);
        }
    }
    if (lastOut !== 3 * scale * scale) throw new Error(`compact net: last layer has ${lastOut} channels, expected ${3 * scale * scale}`);
    const detail = g.node('DepthToSpace', [x], { blocksize: scale, mode: 'CRD' });
    let base = nearest(g, input, scale);
    if (type === FLOAT16) base = g.node('Cast', [base], { to: FLOAT16 });
    end(g, g.node('Add', [detail, base]), type);
    checkAllUsed(sd, used);
    return g;
}

export function buildRRDB(sd, scale, type = FLOAT) {
    if (scale !== 4) throw new Error('rrdb net: only ×4 checkpoints are supported');
    const used = new Set();
    const { g, x: start } = begin(type);
    const lrelu = x => g.node('LeakyRelu', [x], { alpha: LEAKY });
    const residual = g.constant([], [RESIDUAL], { name: 'residual_scale' });

    const dense = (x, prefix) => {
        const feats = [x];
        for (let i = 1; i <= 4; i++) {
            const inp = feats.length === 1 ? x : g.node('Concat', [...feats], { axis: 1 });
            feats.push(lrelu(conv(g, sd, used, inp, `${prefix}.conv${i}`)));
        }
        const x5 = conv(g, sd, used, g.node('Concat', feats, { axis: 1 }), `${prefix}.conv5`, RESIDUAL);   // ×0.2 folded in
        return g.node('Add', [x5, x]);
    };

    const blocks = new Set([...sd.keys()].map(k => k.match(/^body\.(\d+)\.rdb1\.conv1\.weight$/)?.[1]).filter(Boolean)).size;
    if (!blocks) throw new Error('rrdb net: no body.N.rdb1 blocks');
    const feat = conv(g, sd, used, start, 'conv_first');
    let body = feat;
    for (let b = 0; b < blocks; b++) {
        let x = body;
        for (let r = 1; r <= 3; r++) x = dense(x, `body.${b}.rdb${r}`);
        body = g.node('Add', [g.node('Mul', [x, residual]), body]);
    }
    let y = g.node('Add', [feat, conv(g, sd, used, body, 'conv_body')]);
    y = lrelu(conv(g, sd, used, nearest(g, y, 2), 'conv_up1'));
    y = lrelu(conv(g, sd, used, nearest(g, y, 2), 'conv_up2'));
    y = conv(g, sd, used, lrelu(conv(g, sd, used, y, 'conv_hr')), 'conv_last');
    end(g, y, type);
    checkAllUsed(sd, used);
    return g;
}

export const BUILDERS = { compact: buildCompact, rrdb: buildRRDB };
export { FLOAT, FLOAT16, INT64 };
