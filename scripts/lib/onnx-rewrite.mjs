// Rewrites ready-made ONNX models so they run in the browser.
//
// fuseDeformConv: exporters without the DeformConv operator spell a deformable convolution out as ~120 basic ops
// (index arithmetic in int64, four GatherND for bilinear sampling, …). The runtime keeps the int64 part on the CPU and
// the intermediate index tensors are huge – the cut-out model needed 6 GB, more than WebAssembly can address (4 GB).
// Each such block (one module scope with offset conv, modulator conv, 2·sigmoid mask and the regular conv weight) is
// replaced by one DeformConv node (opset 19, native kernel in the runtime) – same result.
//
// limitNodeWidth: a shader may bind only a limited number of
// storage buffers (8 are guaranteed by WebGPU, many GPUs offer 16), and the runtime turns a Concat / Split node into
// one shader with a buffer per input/output. Exported models contain Concat nodes with up to 1024 inputs and Split
// nodes with 32 outputs (image patches). They are replaced by trees of nodes with at most MAX_WIDTH inputs / outputs –
// same result, a few extra copies on the GPU. Everything else in the file is kept byte for byte.
//
// Only the protobuf structure needed for this is parsed (ModelProto → GraphProto → NodeProto → AttributeProto →
// TensorProto); unknown fields are written back unchanged.
import { Writer, writeAttribute, writeTensor, INT64, FLOAT, FLOAT16 } from './onnx-writer.mjs';

/** inputs (Concat) resp. outputs (Split) per node – plus the one output/input = 8 storage buffers */
export const MAX_WIDTH = 7;

// --- generic protobuf: fields of a message as { num, wire, value } ---

function readVarint(buf, pos) {
    let result = 0n, shift = 0n;
    for (;;) {
        const b = buf[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) return [result, pos];
        shift += 7n;
    }
}

export function parseMessage(buf) {
    const fields = [];
    let p = 0;
    while (p < buf.length) {
        let key, value;
        [key, p] = readVarint(buf, p);
        const num = Number(key >> 3n), wire = Number(key & 7n);
        if (wire === 0) [value, p] = readVarint(buf, p);
        else if (wire === 1) { value = buf.subarray(p, p + 8); p += 8; }
        else if (wire === 2) {
            let len;
            [len, p] = readVarint(buf, p);
            value = buf.subarray(p, p + Number(len));
            p += Number(len);
        } else if (wire === 5) { value = buf.subarray(p, p + 4); p += 4; }
        else throw new Error(`protobuf: unsupported wire type ${wire}`);
        fields.push({ num, wire, value });
    }
    return fields;
}

export function serializeMessage(fields) {
    const w = new Writer();
    for (const f of fields) {
        w.tag(f.num, f.wire);
        if (f.wire === 0) w.varint(f.value);
        else if (f.wire === 2) { w.varint(f.value.length); w.bytes(f.value); }
        else w.bytes(f.value);
    }
    return w.finish();
}

const text = new TextDecoder();
const strings = (fields, num) => fields.filter(f => f.num === num).map(f => text.decode(f.value));
const signed = v => Number(BigInt.asIntN(64, v));

// --- ONNX pieces ---

function readNode(buf) {
    const fields = parseMessage(buf);
    const attrs = {};
    for (const f of fields.filter(x => x.num === 5)) {
        const a = parseMessage(f.value);
        const name = strings(a, 1)[0];
        attrs[name] = a;
    }
    return { inputs: strings(fields, 1), outputs: strings(fields, 2), name: strings(fields, 3)[0] ?? '', op: strings(fields, 4)[0] ?? '', domain: strings(fields, 7)[0] ?? '', attrs };
}

const intAttr = (attrs, name, fallback) => {
    const a = attrs[name];
    const f = a?.find(x => x.num === 3);
    return f ? signed(f.value) : fallback;
};

/** int64 values of a TensorProto (raw_data or int64_data) */
function tensorInts(buf) {
    const fields = parseMessage(buf);
    const type = Number(fields.find(f => f.num === 2)?.value ?? 0n);
    if (type !== INT64) throw new Error(`expected an int64 tensor, got type ${type}`);
    const raw = fields.find(f => f.num === 9)?.value;
    if (raw) {
        const copy = new Uint8Array(raw);
        return [...new BigInt64Array(copy.buffer)].map(Number);
    }
    const out = [];
    for (const f of fields.filter(x => x.num === 7)) {
        if (f.wire === 0) out.push(signed(f.value));
        else { let p = 0; while (p < f.value.length) { let v; [v, p] = readVarint(f.value, p); out.push(signed(v)); } }
    }
    return out;
}

function nodeBytes({ inputs, outputs, name, op, attrs = {} }) {
    const w = new Writer();
    for (const i of inputs) w.string(1, i);
    for (const o of outputs) w.string(2, o);
    w.string(3, name);
    w.string(4, op);
    for (const [k, v] of Object.entries(attrs)) w.message(5, a => writeAttribute(a, k, v));
    return w.finish();
}

const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

/**
 * Rewrite wide Concat / Split nodes (see above). Returns { bytes, concat, split } – the new model and how many nodes
 * were replaced.
 */
export function limitNodeWidth(modelBytes, maxWidth = MAX_WIDTH) {
    const model = parseMessage(modelBytes);
    const graphField = model.find(f => f.num === 7);
    const graph = parseMessage(graphField.value);
    // Constant nodes by output (Split sizes)
    const constants = new Map();
    for (const f of graph) {
        if (f.num !== 1) continue;
        const n = readNode(f.value);
        if (n.op === 'Constant' && n.attrs.value) constants.set(n.outputs[0], n.attrs.value.find(x => x.num === 5)?.value);
    }
    let counter = 0, concats = 0, splits = 0;
    const newInits = [];
    const fresh = base => `${base}/w${counter++}`;
    const sizesConst = (base, sizes) => {
        const name = fresh(`${base}_sizes`);
        newInits.push({ name, dims: [sizes.length], type: INT64, raw: new Uint8Array(BigInt64Array.from(sizes, BigInt).buffer) });
        return name;
    };

    // Concat tree: groups of maxWidth inputs → intermediate results → … → the original output
    const concatTree = (inputs, output, axis, base, out) => {
        if (inputs.length <= maxWidth) {
            out.push(nodeBytes({ inputs, outputs: [output], name: fresh(base), op: 'Concat', attrs: { axis } }));
            return;
        }
        const mids = chunk(inputs, maxWidth).map(group => {
            if (group.length === 1) return group[0];
            const mid = fresh(`${base}_part`);
            out.push(nodeBytes({ inputs: group, outputs: [mid], name: fresh(base), op: 'Concat', attrs: { axis } }));
            return mid;
        });
        concatTree(mids, output, axis, base, out);
    };
    // Split tree: first into groups (sizes summed), then each group into its outputs
    const splitTree = (input, outputs, sizes, axis, base, out) => {
        if (outputs.length <= maxWidth) {
            if (outputs.length === 1) out.push(nodeBytes({ inputs: [input], outputs, name: fresh(base), op: 'Identity' }));
            else out.push(nodeBytes({ inputs: [input, sizesConst(base, sizes)], outputs, name: fresh(base), op: 'Split', attrs: { axis } }));
            return;
        }
        const groupOuts = chunk(outputs, maxWidth);
        const groupSizes = chunk(sizes, maxWidth);
        const mids = groupOuts.map(() => fresh(`${base}_part`));
        splitTree(input, mids, groupSizes.map(g => g.reduce((a, b) => a + b, 0)), axis, base, out);
        groupOuts.forEach((g, i) => splitTree(mids[i], g, groupSizes[i], axis, base, out));
    };

    const newGraph = [];
    for (const f of graph) {
        if (f.num !== 1) { newGraph.push(f); continue; }
        const n = readNode(f.value);
        const replaced = [];
        if (n.op === 'Concat' && !n.domain && n.inputs.length > maxWidth) {
            concatTree(n.inputs, n.outputs[0], intAttr(n.attrs, 'axis', 0), n.name || 'Concat', replaced);
            concats++;
        } else if (n.op === 'Split' && !n.domain && n.outputs.length > maxWidth) {
            const t = constants.get(n.inputs[1]);
            if (!t) throw new Error(`Split ${n.name}: sizes are not a constant – cannot rewrite`);
            const sizes = tensorInts(t);
            if (sizes.length !== n.outputs.length) throw new Error(`Split ${n.name}: ${sizes.length} sizes for ${n.outputs.length} outputs`);
            splitTree(n.inputs[0], n.outputs, sizes, intAttr(n.attrs, 'axis', 0), n.name || 'Split', replaced);
            splits++;
        }
        if (replaced.length) for (const b of replaced) newGraph.push({ num: 1, wire: 2, value: b });
        else newGraph.push(f);
    }
    for (const t of newInits) {
        const w = new Writer();
        writeTensor(w, t);
        newGraph.push({ num: 5, wire: 2, value: w.finish() });
    }
    const newModel = model.map(f => (f === graphField ? { num: 7, wire: 2, value: serializeMessage(newGraph) } : f));
    return { bytes: serializeMessage(newModel), concat: concats, split: splits };
}

// --- DeformConv fusion ---

const intsAttr = (attrs, name) => {
    const out = [];
    for (const f of attrs[name] ?? []) {
        if (f.num !== 8) continue;
        if (f.wire === 0) out.push(signed(f.value));
        else { let p = 0; while (p < f.value.length) { let v; [v, p] = readVarint(f.value, p); out.push(signed(v)); } }
    }
    return out;
};

/**
 * Replace spelled-out deformable convolutions by DeformConv (see top). A block is recognised by its module scope
 * `<scope>/offset_conv/Conv`; everything else in `<scope>/` except the offset conv, the modulator conv, its Sigmoid and
 * the ×2 (mask) is removed. Strict: a block that does not look exactly like that stops the conversion.
 * Returns { bytes, fused }.
 */
export function fuseDeformConv(modelBytes) {
    const model = parseMessage(modelBytes);
    const graphField = model.find(f => f.num === 7);
    const graph = parseMessage(graphField.value);
    const nodes = graph.filter(f => f.num === 1).map(f => ({ field: f, ...readNode(f.value) }));
    const initType = new Map();
    for (const f of graph.filter(x => x.num === 5)) {
        const t = parseMessage(f.value);
        initType.set(strings(t, 8)[0], Number(t.find(x => x.num === 2)?.value ?? 0n));
    }
    const graphOutputs = new Set(graph.filter(f => f.num === 12).map(f => strings(parseMessage(f.value), 1)[0]));
    const consumers = new Map();
    nodes.forEach((n, i) => n.inputs.forEach(name => { if (!consumers.has(name)) consumers.set(name, []); consumers.get(name).push(i); }));

    const remove = new Set();
    const insertAt = new Map();   // node index → replacement node bytes (placed where the block's last node was)
    let fused = 0, counter = 0;
    nodes.forEach((offsetConv, oi) => {
        if (offsetConv.op !== 'Conv' || !offsetConv.name.endsWith('/offset_conv/Conv')) return;
        const scope = offsetConv.name.slice(0, -'/offset_conv/Conv'.length);
        const inside = [];
        nodes.forEach((n, i) => { if (n.name.startsWith(scope + '/')) inside.push(i); });
        const byName = suffix => inside.find(i => nodes[i].name === scope + suffix);
        const mi = byName('/modulator_conv/Conv'), si = byName('/Sigmoid'), xi = byName('/Mul');
        if (mi === undefined || si === undefined || xi === undefined) throw new Error(`deform block ${scope}: modulator/sigmoid/mask missing`);
        const sig = nodes[si], mask = nodes[xi];
        if (sig.inputs[0] !== nodes[mi].outputs[0] || !mask.inputs.includes(sig.outputs[0])) throw new Error(`deform block ${scope}: unexpected mask structure`);
        // keep the four nodes and whatever in the block feeds them (e.g. the constant 2 of the mask)
        const keep = new Set([oi, mi, si, xi]);
        const producerInside = new Map(inside.flatMap(i => nodes[i].outputs.map(o => [o, i])));
        const stack = [...keep];
        while (stack.length) {
            for (const name of nodes[stack.pop()].inputs) {
                const p = producerInside.get(name);
                if (p !== undefined && !keep.has(p)) { keep.add(p); stack.push(p); }
            }
        }
        const drop = inside.filter(i => !keep.has(i));
        const dropOut = new Set(drop.flatMap(i => nodes[i].outputs));
        const external = [...dropOut].filter(o => graphOutputs.has(o) || (consumers.get(o) ?? []).some(c => !drop.includes(c)));
        if (external.length !== 1) throw new Error(`deform block ${scope}: ${external.length} outputs leave the block`);
        const weight = [...new Set(drop.flatMap(i => nodes[i].inputs))].filter(name => /regular_conv\.weight$/.test(name));
        const bias = [...new Set(drop.flatMap(i => nodes[i].inputs))].filter(name => /regular_conv\.bias$/.test(name));
        if (weight.length !== 1) throw new Error(`deform block ${scope}: regular conv weight not found`);
        const x = offsetConv.inputs[0], offset = offsetConv.outputs[0], out = external[0];
        const attrs = {
            kernel_shape: intsAttr(offsetConv.attrs, 'kernel_shape'),
            pads: intsAttr(offsetConv.attrs, 'pads'),
            strides: intsAttr(offsetConv.attrs, 'strides'),
            dilations: intsAttr(offsetConv.attrs, 'dilations'),
            group: 1,
            offset_group: 1,
        };
        const half = initType.get(weight[0]) === FLOAT16;
        const name = `${scope}/DeformConv`;
        const replacement = [];
        // the runtime's DeformConv kernel is float32 only: half-float models get casts around it
        const toFloat = v => {
            if (!half || !v) return v;
            const c = `${name}/cast${counter++}`;
            replacement.push(nodeBytes({ inputs: [v], outputs: [c], name: c, op: 'Cast', attrs: { to: FLOAT } }));
            return c;
        };
        const inputs = [toFloat(x), toFloat(weight[0]), toFloat(offset), toFloat(bias[0] ?? ''), toFloat(mask.outputs[0])];
        const result = half ? `${name}/out` : out;
        replacement.push(nodeBytes({ inputs, outputs: [result], name, op: 'DeformConv', attrs }));
        if (half) replacement.push(nodeBytes({ inputs: [result], outputs: [out], name: `${name}/cast_out`, op: 'Cast', attrs: { to: FLOAT16 } }));
        for (const i of drop) remove.add(i);
        insertAt.set(Math.max(...drop), replacement);
        fused++;
    });
    if (!fused) return { bytes: modelBytes, fused };

    const newGraph = [];
    let nodeIndex = 0;
    for (const f of graph) {
        if (f.num !== 1) { newGraph.push(f); continue; }
        const i = nodeIndex++;
        if (insertAt.has(i)) for (const b of insertAt.get(i)) newGraph.push({ num: 1, wire: 2, value: b });
        if (!remove.has(i)) newGraph.push(f);
    }
    // DeformConv needs opset 19 in the default domain (the other ops of these models mean the same in 17 and 19)
    const newModel = model.map(f => {
        if (f === graphField) return { num: 7, wire: 2, value: serializeMessage(newGraph) };
        if (f.num === 8) {
            const op = parseMessage(f.value);
            if ((strings(op, 1)[0] ?? '') === '' && signed(op.find(x => x.num === 2).value) < 19) {
                return { num: 8, wire: 2, value: serializeMessage([{ num: 1, wire: 2, value: new Uint8Array() }, { num: 2, wire: 0, value: 19n }]) };
            }
        }
        return f;
    });
    return { bytes: serializeMessage(newModel), fused };
}
