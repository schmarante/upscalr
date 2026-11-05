// Writes ONNX models without the onnx package: a small graph builder plus a protobuf encoder for the few message
// types a model needs (ModelProto, GraphProto, NodeProto, AttributeProto, TensorProto, ValueInfoProto).
// Field numbers follow onnx.proto (proto2); repeated numbers are written packed, which every parser accepts.

export const FLOAT = 1, INT64 = 7, FLOAT16 = 10;

// --- protobuf wire format ---

export class Writer {
    constructor() { this.parts = []; this.length = 0; }
    bytes(b) { this.parts.push(b); this.length += b.length; }
    varint(v) {
        let n = BigInt.asUintN(64, BigInt(v));
        const out = [];
        do {
            let byte = Number(n & 0x7fn);
            n >>= 7n;
            if (n) byte |= 0x80;
            out.push(byte);
        } while (n);
        this.bytes(Uint8Array.from(out));
    }
    tag(field, wire) { this.varint((field << 3) | wire); }
    int(field, v) { this.tag(field, 0); this.varint(v); }
    float(field, v) { this.tag(field, 5); const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.bytes(b); }
    raw(field, b) { this.tag(field, 2); this.varint(b.length); this.bytes(b); }
    string(field, s) { this.raw(field, new TextEncoder().encode(s)); }
    message(field, fill) { const w = new Writer(); fill(w); this.raw(field, w.finish()); }
    packedInts(field, values) { const w = new Writer(); for (const v of values) w.varint(v); this.raw(field, w.finish()); }
    finish() {
        const out = new Uint8Array(this.length);
        let o = 0;
        for (const p of this.parts) { out.set(p, o); o += p.length; }
        return out;
    }
}

// AttributeProto.AttributeType
const ATTR_FLOAT = 1, ATTR_INT = 2, ATTR_STRING = 3, ATTR_INTS = 7;

export function writeAttribute(w, name, value) {
    w.string(1, name);
    if (typeof value === 'string') { w.string(4, value); w.int(20, ATTR_STRING); }
    else if (Array.isArray(value)) { w.packedInts(8, value); w.int(20, ATTR_INTS); }
    else if (value instanceof Float) { w.float(2, value.v); w.int(20, ATTR_FLOAT); }
    else if (Number.isInteger(value)) { w.int(3, value); w.int(20, ATTR_INT); }
    else { w.float(2, value); w.int(20, ATTR_FLOAT); }
}

/** marks a float attribute whose value happens to be whole (e.g. 1.0), which would otherwise be written as int */
export class Float { constructor(v) { this.v = v; } }

export function writeTensor(w, t) {
    w.packedInts(1, t.dims);
    w.int(2, t.type);
    w.string(8, t.name);
    w.raw(9, t.raw);
}

function writeValueInfo(w, name, type, dims) {
    w.string(1, name);
    w.message(2, tp => tp.message(1, tt => {   // TypeProto.tensor_type
        tt.int(1, type);
        tt.message(2, shape => {
            for (const d of dims) shape.message(1, dim => (typeof d === 'string' ? dim.string(2, d) : dim.int(1, d)));
        });
    }));
}

// --- float16 ---

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** float → IEEE half (round to nearest even) */
export function floatToHalf(value) {
    f32[0] = value;
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff, mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);   // inf / nan
    const e = exp - 127 + 15;
    if (e >= 0x1f) return sign | 0x7c00;                            // overflow → inf
    if (e <= 0) {                                                   // subnormal or zero
        if (e < -10) return sign;
        const m = mant | 0x800000, shift = 14 - e;
        let h = m >>> shift;
        const rest = m & ((1 << shift) - 1), half = 1 << (shift - 1);
        if (rest > half || (rest === half && (h & 1))) h++;
        return sign | h;
    }
    let h = (e << 10) | (mant >>> 13);
    const rest = mant & 0x1fff;
    if (rest > 0x1000 || (rest === 0x1000 && (h & 1))) h++;         // may carry into the exponent – still correct
    return sign | h;
}

// --- graph builder ---

export class Graph {
    /** @param {number} type  element type of weights and activations (FLOAT or FLOAT16) */
    constructor(type = FLOAT) {
        this.type = type;
        this.nodes = [];
        this.initializers = [];
        this.inputs = [];
        this.outputs = [];
        this.count = 0;
    }
    unique(prefix) { return `${prefix}_${this.count++}`; }

    /** constant tensor; float data is stored in the graph's element type unless `type` says otherwise */
    constant(dims, values, { type = this.type, name = this.unique('const') } = {}) {
        let raw;
        if (type === FLOAT16) {
            const h = new Uint16Array(values.length);
            for (let i = 0; i < values.length; i++) h[i] = floatToHalf(values[i]);
            raw = new Uint8Array(h.buffer);
        } else if (type === FLOAT) {
            raw = new Uint8Array(Float32Array.from(values).buffer);
        } else if (type === INT64) {
            raw = new Uint8Array(BigInt64Array.from(values, v => BigInt(v)).buffer);
        } else {
            throw new Error(`unsupported constant type ${type}`);
        }
        this.initializers.push({ name, dims, type, raw });
        return name;
    }

    /** add a node, returns its (first) output name */
    node(op, inputs, attrs = {}, output = this.unique(op.toLowerCase())) {
        this.nodes.push({ op, inputs, outputs: [output], attrs });
        return output;
    }

    input(name, type, dims) { this.inputs.push({ name, type, dims }); return name; }
    output(name, type, dims) { this.outputs.push({ name, type, dims }); return name; }

    /** serialize as ModelProto */
    encode({ opset = 17, producer = 'upscalr', version = '1', doc = '', metadata = {} } = {}) {
        const m = new Writer();
        m.int(1, 8);                                   // ir_version 8 (opset 17)
        m.string(2, producer);
        m.string(3, version);
        if (doc) m.string(6, doc);
        m.message(7, g => {
            for (const n of this.nodes) {
                g.message(1, w => {
                    for (const i of n.inputs) w.string(1, i);
                    for (const o of n.outputs) w.string(2, o);
                    w.string(3, n.outputs[0]);
                    w.string(4, n.op);
                    for (const [k, v] of Object.entries(n.attrs)) w.message(5, a => writeAttribute(a, k, v));
                });
            }
            g.string(2, 'main');
            for (const t of this.initializers) g.message(5, w => writeTensor(w, t));
            for (const i of this.inputs) g.message(11, w => writeValueInfo(w, i.name, i.type, i.dims));
            for (const o of this.outputs) g.message(12, w => writeValueInfo(w, o.name, o.type, o.dims));
        });
        m.message(8, o => { o.string(1, ''); o.int(2, opset); });
        for (const [key, value] of Object.entries(metadata)) m.message(14, e => { e.string(1, key); e.string(2, String(value)); });
        return m.finish();
    }
}
