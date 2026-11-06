// The network structures of the upscaling models and of the deblurring model (nafnet, further below),
// rebuilt as ONNX graphs from the published layer layout.
// Layers are found by the names in the state dict; missing or extra tensors stop the conversion.
//
// compact: a plain stack of 3×3 convolutions with per-channel PReLU at low resolution, the last convolution yields
//          scale² × 3 channels that a depth-to-space step turns into the image; the nearest-upscaled input is added
//          (the network only learns the difference). Small and fast.
// rrdb:    residual-in-residual dense blocks – each block holds three dense blocks of five convolutions whose inputs
//          are all previous feature maps concatenated; residuals are scaled by 0.2. Upscaling by two nearest ×2 steps,
//          each followed by a convolution. Larger, sharper.
//
// I/O of every model: input "input" float32 [1, 3, H, W] RGB in 0…1, output "output" float32 [1, 3, H·s, W·s] (s = 1 for nafnet)
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

// --- nafnet: image restoration (deblurring) at the same size ---
//
// A U-net of "NAF blocks" (no non-linear activation functions): intro conv → per level a stack of blocks, kept as
// skip, then a 2×2 convolution with stride 2 (half size, double channels) → middle blocks → per level 1×1 conv +
// depth-to-space (double size, half channels) + skip → blocks → ending conv + input. A block: channel layer norm →
// 1×1 conv to 2c → depthwise 3×3 → "simple gate" (first half × second half) → channel attention (global mean →
// 1×1 conv → ×) → 1×1 conv, ×beta, + input; then norm → 1×1 conv to 2c → gate → 1×1 conv, ×gamma, + input.
// Folded at conversion: the norm's scale/shift into the next 1×1 conv, beta/gamma into the conv before them, the gate
// as two half convolutions (no Split node). Height and width must be multiples of 2^levels (16).

const NORM_EPS = 1e-6;

/** convolution from (already folded) weights; stride 2 = the 2×2 down step without padding */
function convRaw(g, x, name, w, b, { stride = 1, group = 1 } = {}) {
    const [, , kh, kw] = w.shape;
    const pad = stride === 1 ? kh >> 1 : 0;
    const inputs = [x, g.constant(w.shape, w.data, { name: `${name}.weight` })];
    if (b) inputs.push(g.constant(b.shape, b.data, { name: `${name}.bias` }));
    return g.node('Conv', inputs, { kernel_shape: [kh, kw], pads: [pad, pad, pad, pad], strides: [stride, stride], group });
}

/** output channels from…to of a weight [O, …] / bias [O] */
function rows(t, from, to) {
    const per = t.data.length / t.shape[0];
    return { shape: [to - from, ...t.shape.slice(1)], data: t.data.slice(from * per, to * per) };
}

/** 1×1 conv after a channel norm with scale s / shift m: W' = W·diag(s), b' = b + W·m */
function foldNorm(w, b, s, m) {
    const [o, c] = w.shape;
    const W = new Float32Array(w.data.length), B = Float32Array.from(b.data);
    for (let i = 0; i < o; i++) for (let j = 0; j < c; j++) {
        W[i * c + j] = w.data[i * c + j] * s.data[j];
        B[i] += w.data[i * c + j] * m.data[j];
    }
    return [{ shape: w.shape, data: W }, { shape: b.shape, data: B }];
}

/** conv whose output is multiplied per channel by f [1, O, 1, 1] */
function foldScale(w, b, f) {
    const per = w.data.length / w.shape[0];
    return [
        { shape: w.shape, data: w.data.map((v, i) => v * f.data[Math.floor(i / per)]) },
        { shape: b.shape, data: b.data.map((v, i) => v * f.data[i]) },
    ];
}

export function buildNAFNet(sd, scale, type = FLOAT) {
    if (scale !== 1) throw new Error('nafnet: restores at the same size (scale 1)');
    const used = new Set();
    const T = name => take(sd, used, name);
    const { g, x: start } = begin(type);
    const eps = g.constant([], [NORM_EPS], { name: 'norm_eps', type: FLOAT });

    /**
     * layer norm over the channels of each pixel (scale/shift folded into the next conv) – always in float32: the
     * squared deviations reach 2·10⁷ (half floats end at 65504 → NaN on the GPU; measured on a phone photo)
     */
    const norm = x => {
        const x32 = type === FLOAT16 ? g.node('Cast', [x], { to: FLOAT }) : x;
        const d = g.node('Sub', [x32, g.node('ReduceMean', [x32], { axes: [1], keepdims: 1 })]);
        const v = g.node('ReduceMean', [g.node('Mul', [d, d])], { axes: [1], keepdims: 1 });
        const n = g.node('Div', [d, g.node('Sqrt', [g.node('Add', [v, eps])])]);
        return type === FLOAT16 ? g.node('Cast', [n], { to: FLOAT16 }) : n;
    };
    /** mean over the picture per channel (channel attention) – float32: summing a whole tile in half floats overflows */
    const mean = x => type === FLOAT16
        ? g.node('Cast', [g.node('GlobalAveragePool', [g.node('Cast', [x], { to: FLOAT })])], { to: FLOAT16 })
        : g.node('GlobalAveragePool', [x]);
    const block = (x, p) => {
        const c = T(`${p}.conv3.weight`).shape[0];
        // first half: norm → 1×1 (2c) → depthwise 3×3 → gate → attention → 1×1, ×beta
        const [w1, b1] = foldNorm(T(`${p}.conv1.weight`), T(`${p}.conv1.bias`), T(`${p}.norm1.weight`), T(`${p}.norm1.bias`));
        const w2 = T(`${p}.conv2.weight`), b2 = T(`${p}.conv2.bias`);
        const n1 = norm(x);
        const half = (k, from) => convRaw(g, convRaw(g, n1, `${p}.conv1.${k}`, rows(w1, from, from + c), rows(b1, from, from + c)),
            `${p}.conv2.${k}`, rows(w2, from, from + c), rows(b2, from, from + c), { group: c });
        let t = g.node('Mul', [half(0, 0), half(1, c)]);
        t = g.node('Mul', [t, convRaw(g, mean(t), `${p}.sca`, T(`${p}.sca.1.weight`), T(`${p}.sca.1.bias`))]);
        const [w3, b3] = foldScale(T(`${p}.conv3.weight`), T(`${p}.conv3.bias`), T(`${p}.beta`));
        const y = g.node('Add', [x, convRaw(g, t, `${p}.conv3`, w3, b3)]);
        // second half: norm → 1×1 (2c) → gate → 1×1, ×gamma
        const [w4, b4] = foldNorm(T(`${p}.conv4.weight`), T(`${p}.conv4.bias`), T(`${p}.norm2.weight`), T(`${p}.norm2.bias`));
        const n2 = norm(y);
        const u = g.node('Mul', [convRaw(g, n2, `${p}.conv4.0`, rows(w4, 0, c), rows(b4, 0, c)), convRaw(g, n2, `${p}.conv4.1`, rows(w4, c, 2 * c), rows(b4, c, 2 * c))]);
        const [w5, b5] = foldScale(T(`${p}.conv5.weight`), T(`${p}.conv5.bias`), T(`${p}.gamma`));
        return g.node('Add', [y, convRaw(g, u, `${p}.conv5`, w5, b5)]);
    };
    const count = re => new Set([...sd.keys()].map(k => k.match(re)?.[1]).filter(Boolean)).size;
    const stack = (x, prefix) => {
        const n = count(new RegExp(`^${prefix.replaceAll('.', '\\.')}\\.(\\d+)\\.conv1\\.weight$`));
        for (let i = 0; i < n; i++) x = block(x, `${prefix}.${i}`);
        return x;
    };

    const levels = count(/^downs\.(\d+)\.weight$/);
    if (!levels) throw new Error('nafnet: no downs.N layers');
    let x = convRaw(g, start, 'intro', T('intro.weight'), T('intro.bias'));
    const skips = [];
    for (let i = 0; i < levels; i++) {
        x = stack(x, `encoders.${i}`);
        skips.push(x);
        x = convRaw(g, x, `downs.${i}`, T(`downs.${i}.weight`), T(`downs.${i}.bias`), { stride: 2 });
    }
    x = stack(x, 'middle_blks');
    for (let i = 0; i < levels; i++) {
        x = g.node('DepthToSpace', [convRaw(g, x, `ups.${i}`, T(`ups.${i}.0.weight`))], { blocksize: 2, mode: 'CRD' });
        x = stack(g.node('Add', [x, skips[levels - 1 - i]]), `decoders.${i}`);
    }
    x = convRaw(g, x, 'ending', T('ending.weight'), T('ending.bias'));
    end(g, g.node('Add', [x, start]), type);
    checkAllUsed(sd, used);
    return g;
}

export const BUILDERS = { compact: buildCompact, rrdb: buildRRDB, nafnet: buildNAFNet };
export { FLOAT, FLOAT16, INT64 };
