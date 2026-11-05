// Reads the tensors of a PyTorch checkpoint (.pth, zip format) without PyTorch.
//
// A checkpoint is a zip archive: <prefix>/data.pkl describes the objects (Python pickle), <prefix>/data/<key> holds
// the raw bytes of each tensor storage. Pickle is a small stack machine that can call arbitrary Python functions –
// this reader runs only the opcodes a state dict needs and accepts only the handful of globals listed in GLOBALS
// (dicts, tensor rebuilding, storage types). Anything else is rejected, so a file can never run code.
import { inflateRawSync } from 'node:zlib';

// --- zip (stored or deflated entries, read from the central directory) ---

function readZip(buf) {
    // end of central directory: signature 0x06054b50 within the last 64 KiB
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
    let count = buf.readUInt16LE(eocd + 10);
    let dirOffset = buf.readUInt32LE(eocd + 16);
    // zip64: the counts/offsets above are 0xffff/0xffffffff, the real values sit in the zip64 records
    if (dirOffset === 0xffffffff || count === 0xffff) {
        const locator = eocd - 20;
        if (buf.readUInt32LE(locator) !== 0x07064b50) throw new Error('zip64 locator missing');
        const z64 = Number(buf.readBigUInt64LE(locator + 8));
        if (buf.readUInt32LE(z64) !== 0x06064b50) throw new Error('zip64 end of central directory missing');
        count = Number(buf.readBigUInt64LE(z64 + 32));
        dirOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
    const entries = new Map();
    let p = dirOffset;
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip central directory');
        const method = buf.readUInt16LE(p + 10);
        let compSize = buf.readUInt32LE(p + 20);
        let size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        let local = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        // zip64 extra field (id 1): the 0xffffffff values in order size, compressed size, local header offset
        let e = p + 46 + nameLen;
        const extraEnd = e + extraLen;
        while (e + 4 <= extraEnd) {
            const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
            if (id === 1) {
                let q = e + 4;
                if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
                if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
                if (local === 0xffffffff) { local = Number(buf.readBigUInt64LE(q)); }
            }
            e += 4 + len;
        }
        entries.set(name, { method, compSize, size, local });
        p = extraEnd + commentLen;
    }
    return {
        names: [...entries.keys()],
        read(name) {
            const en = entries.get(name);
            if (!en) throw new Error(`zip entry missing: ${name}`);
            if (buf.readUInt32LE(en.local) !== 0x04034b50) throw new Error(`broken local header: ${name}`);
            const start = en.local + 30 + buf.readUInt16LE(en.local + 26) + buf.readUInt16LE(en.local + 28);
            const raw = buf.subarray(start, start + en.compSize);
            if (en.method === 0) return raw;
            if (en.method === 8) return inflateRawSync(raw);
            throw new Error(`unsupported zip compression ${en.method}: ${name}`);
        },
    };
}

// --- restricted unpickler ---

const DTYPES = {
    FloatStorage: { name: 'float32', bytes: 4 },
    HalfStorage: { name: 'float16', bytes: 2 },
    DoubleStorage: { name: 'float64', bytes: 8 },
    LongStorage: { name: 'int64', bytes: 8 },
    IntStorage: { name: 'int32', bytes: 4 },
};

const MARK = Symbol('mark');
const ORDERED_DICT = { kind: 'global', name: 'collections.OrderedDict' };
const REBUILD_TENSOR = { kind: 'global', name: 'torch._utils._rebuild_tensor_v2' };
const REBUILD_PARAMETER = { kind: 'global', name: 'torch._utils._rebuild_parameter' };

function resolveGlobal(module, name) {
    const full = `${module}.${name}`;
    if (full === 'collections.OrderedDict') return ORDERED_DICT;
    if (full === 'torch._utils._rebuild_tensor_v2') return REBUILD_TENSOR;
    if (full === 'torch._utils._rebuild_parameter') return REBUILD_PARAMETER;
    if (module === 'torch' && DTYPES[name]) return { kind: 'storageType', dtype: DTYPES[name] };
    throw new Error(`checkpoint uses an unsupported Python global: ${full}`);
}

function call(fn, args) {
    if (fn === ORDERED_DICT) return new Map();
    if (fn === REBUILD_TENSOR) {
        const [storage, offset, shape, stride] = args;
        return { kind: 'tensor', storage, offset, shape, stride };
    }
    if (fn === REBUILD_PARAMETER) return args[0];
    throw new Error(`checkpoint calls an unsupported function: ${fn?.name ?? typeof fn}`);
}

function unpickle(data, persistentLoad) {
    const stack = [];
    const memo = new Map();
    let p = 0;
    const u8 = () => data[p++];
    const u16 = () => { const v = data.readUInt16LE(p); p += 2; return v; };
    const u32 = () => { const v = data.readUInt32LE(p); p += 4; return v; };
    const i32 = () => { const v = data.readInt32LE(p); p += 4; return v; };
    const str = n => { const s = data.toString('utf8', p, p + n); p += n; return s; };
    const line = () => { const end = data.indexOf(0x0a, p); const s = data.toString('latin1', p, end); p = end + 1; return s; };
    const popMark = () => {
        const i = stack.lastIndexOf(MARK);
        if (i < 0) throw new Error('pickle: mark missing');
        const items = stack.splice(i);
        items.shift();
        return items;
    };
    const setItems = (target, items) => {
        for (let i = 0; i < items.length; i += 2) {
            if (target instanceof Map) target.set(items[i], items[i + 1]);
            else throw new Error('pickle: SETITEM on a non-dict');
        }
    };
    const longLE = bytes => {
        let v = 0n;
        for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
        if (bytes.length && bytes[bytes.length - 1] & 0x80) v -= 1n << BigInt(bytes.length * 8);
        return Number(v);
    };
    for (;;) {
        const op = u8();
        switch (op) {
            case 0x80: u8(); break;                                    // PROTO
            case 0x95: p += 8; break;                                  // FRAME
            case 0x2e: return stack.pop();                             // STOP
            case 0x28: stack.push(MARK); break;                        // MARK
            case 0x7d: stack.push(new Map()); break;                   // EMPTY_DICT
            case 0x5d: stack.push([]); break;                          // EMPTY_LIST
            case 0x29: stack.push([]); break;                          // EMPTY_TUPLE
            case 0x74: stack.push(popMark()); break;                   // TUPLE
            case 0x85: stack.push([stack.pop()]); break;               // TUPLE1
            case 0x86: { const b = stack.pop(), a = stack.pop(); stack.push([a, b]); break; }               // TUPLE2
            case 0x87: { const c = stack.pop(), b = stack.pop(), a = stack.pop(); stack.push([a, b, c]); break; } // TUPLE3
            case 0x58: stack.push(str(u32())); break;                  // BINUNICODE
            case 0x8c: stack.push(str(u8())); break;                   // SHORT_BINUNICODE
            case 0x8d: { const n = Number(data.readBigUInt64LE(p)); p += 8; stack.push(str(n)); break; } // BINUNICODE8
            case 0x54: stack.push(str(i32())); break;                  // BINSTRING
            case 0x55: stack.push(str(u8())); break;                   // SHORT_BINSTRING
            case 0x4a: stack.push(i32()); break;                       // BININT
            case 0x4b: stack.push(u8()); break;                        // BININT1
            case 0x4d: stack.push(u16()); break;                       // BININT2
            case 0x8a: { const n = u8(); stack.push(longLE(data.subarray(p, p + n))); p += n; break; }  // LONG1
            case 0x8b: { const n = u32(); stack.push(longLE(data.subarray(p, p + n))); p += n; break; } // LONG4
            case 0x47: { const v = data.readDoubleBE(p); p += 8; stack.push(v); break; }                // BINFLOAT
            case 0x4e: stack.push(null); break;                        // NONE
            case 0x88: stack.push(true); break;                        // NEWTRUE
            case 0x89: stack.push(false); break;                       // NEWFALSE
            case 0x63: { const module = line(), name = line(); stack.push(resolveGlobal(module, name)); break; } // GLOBAL
            case 0x93: { const name = stack.pop(), module = stack.pop(); stack.push(resolveGlobal(module, name)); break; } // STACK_GLOBAL
            case 0x71: memo.set(u8(), stack.at(-1)); break;            // BINPUT
            case 0x72: memo.set(u32(), stack.at(-1)); break;           // LONG_BINPUT
            case 0x94: memo.set(memo.size, stack.at(-1)); break;       // MEMOIZE
            case 0x68: stack.push(memo.get(u8())); break;              // BINGET
            case 0x6a: stack.push(memo.get(u32())); break;             // LONG_BINGET
            case 0x51: stack.push(persistentLoad(stack.pop())); break; // BINPERSID
            case 0x52: { const args = stack.pop(), fn = stack.pop(); stack.push(call(fn, args)); break; } // REDUCE
            case 0x81: { const args = stack.pop(), cls = stack.pop(); stack.push(call(cls, args)); break; } // NEWOBJ
            case 0x62: stack.pop(); break;                             // BUILD: object state (_metadata of a state dict) – not needed
            case 0x73: { const v = stack.pop(), k = stack.pop(); setItems(stack.at(-1), [k, v]); break; } // SETITEM
            case 0x75: { const items = popMark(); setItems(stack.at(-1), items); break; }                 // SETITEMS
            case 0x61: { const v = stack.pop(); stack.at(-1).push(v); break; }                            // APPEND
            case 0x65: { const items = popMark(); stack.at(-1).push(...items); break; }                   // APPENDS
            case 0x30: stack.pop(); break;                             // POP
            case 0x31: popMark(); break;                               // POP_MARK
            case 0x32: stack.push(stack.at(-1)); break;                // DUP
            default: throw new Error(`pickle: unsupported opcode 0x${op.toString(16)} at ${p - 1}`);
        }
    }
}

/**
 * Tensors of a checkpoint as Map(name → { shape, data: Float32Array }).
 * @param {Buffer} buf  the .pth file
 * @param {string} [key]  entry of the top-level dict holding the state dict (e.g. 'params_ema'); none = top level
 */
export function readCheckpoint(buf, key) {
    const zip = readZip(buf);
    const pkl = zip.names.find(n => n.endsWith('/data.pkl') || n === 'data.pkl');
    if (!pkl) throw new Error('checkpoint without data.pkl (old non-zip format is not supported)');
    const prefix = pkl.slice(0, -'data.pkl'.length);
    const order = zip.names.find(n => n === `${prefix}byteorder`);
    if (order && zip.read(order).toString().trim() !== 'little') throw new Error('big-endian checkpoint not supported');
    const storages = new Map();
    const root = unpickle(zip.read(pkl), pid => {
        // ('storage', storage type, key, location, element count)
        const [tag, type, storageKey] = pid;
        if (tag !== 'storage' || type?.kind !== 'storageType') throw new Error(`unsupported persistent id ${tag}`);
        if (!storages.has(storageKey)) storages.set(storageKey, { dtype: type.dtype, bytes: zip.read(`${prefix}data/${storageKey}`) });
        return storages.get(storageKey);
    });
    let dict = root;
    if (key) {
        if (!(root instanceof Map) || !root.has(key)) throw new Error(`checkpoint has no "${key}" entry (has: ${root instanceof Map ? [...root.keys()].join(', ') : typeof root})`);
        dict = root.get(key);
    }
    if (!(dict instanceof Map)) throw new Error('state dict is not a dict');
    const tensors = new Map();
    for (const [name, t] of dict) {
        if (t?.kind !== 'tensor') continue;
        const numel = t.shape.reduce((a, b) => a * b, 1);
        // only contiguous tensors (row-major strides) – what state dicts of plain layers contain
        let expected = 1;
        for (let i = t.shape.length - 1; i >= 0; i--) {
            if (t.shape[i] !== 1 && t.stride[i] !== expected) throw new Error(`tensor ${name} is not contiguous`);
            expected *= t.shape[i];
        }
        const { dtype, bytes } = t.storage;
        const start = t.offset * dtype.bytes, end = start + numel * dtype.bytes;
        const raw = bytes.subarray(start, end);
        const copy = new Uint8Array(raw.length);   // own, aligned buffer
        copy.set(raw);
        let data;
        if (dtype.name === 'float32') data = new Float32Array(copy.buffer);
        else if (dtype.name === 'float16') data = Float32Array.from(new Uint16Array(copy.buffer), halfToFloat);
        else if (dtype.name === 'float64') data = Float32Array.from(new Float64Array(copy.buffer));
        else continue;   // integer buffers (e.g. batch-norm counters) are not weights
        tensors.set(name, { shape: t.shape, data });
    }
    return tensors;
}

function halfToFloat(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * 2 ** (e - 15);
}
