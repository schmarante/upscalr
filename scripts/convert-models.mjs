// Converts the upscaling models listed in scripts/models.json to ONNX (npm run models):
// downloads each checkpoint once into .cache/weights/ (checked against its sha256), rebuilds the network as an ONNX
// graph (scripts/lib/nets.mjs) and writes two variants to public/models/ (arch "onnx": ready-made ONNX files per
// precision, checked, copied and made WebGPU-friendly by scripts/lib/onnx-rewrite.mjs) – float32 (any backend) and float16
// (WebGPU with shader-f16: half the download and memory). File names carry a content hash, so the browser cache and
// the app's model cache (Cache API) never serve a stale model. public/models/manifest.json lists the files for the
// app. No PyTorch, no Python: the checkpoint is read by scripts/lib/pth-reader.mjs. Details: docs/models.md.
//
//   node scripts/convert-models.mjs [--only <id>] [--out <dir>] [--cache <dir>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readCheckpoint } from './lib/pth-reader.mjs';
import { BUILDERS, FLOAT, FLOAT16 } from './lib/nets.mjs';
import { fuseDeformConv, limitNodeWidth, opsInFloat32, MAX_WIDTH } from './lib/onnx-rewrite.mjs';

const CONVERTER_VERSION = '1';
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const outDir = path.resolve(root, arg('out', 'public/models'));
const cacheDir = path.resolve(root, arg('cache', '.cache/weights'));
const only = arg('only', null);

const { models } = JSON.parse(fs.readFileSync(path.join(root, 'scripts/models.json'), 'utf8'));
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const mb = n => `${(n / 1048576).toFixed(1)} MB`;

async function download(url, attempts = 5) {
    for (let i = 1; ; i++) {
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) {
            if (i >= attempts) throw new Error(`download failed (${url}): ${e.message}`);
            const wait = 2 ** i;
            console.log(`  download failed (${e.message}), retry in ${wait} s …`);
            await new Promise(r => setTimeout(r, wait * 1000));
        }
    }
}

/** a source file (checkpoint or ready-made ONNX) from the cache or the network, checked against its sha256 */
async function fetchSource(model, source, expected, cacheName = path.basename(new URL(source).pathname)) {
    const file = path.join(cacheDir, cacheName);
    let buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (buf && expected && sha256(buf) !== expected) {
        console.log(`  cached ${path.basename(file)} has the wrong checksum – downloading again`);
        buf = null;
    }
    if (!buf) {
        console.log(`  downloading ${source}`);
        buf = await download(source);
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(file, buf);
    }
    const hash = sha256(buf);
    if (expected && hash !== expected) throw new Error(`${model.id}: checksum mismatch (got ${hash}, expected ${expected})`);
    if (!expected) console.warn(`  WARNING ${model.id}: no sha256 in models.json – this file has ${hash}`);
    return buf;
}

function writeVariant(entry, model, variant, bytes) {
    const hash = sha256(bytes);
    const file = `${model.id}-${hash.slice(0, 10)}.${variant}.onnx`;
    fs.writeFileSync(path.join(outDir, file), bytes);
    entry.variants[variant] = { file, bytes: bytes.length, sha256: hash };
    console.log(`  ${variant}: ${file} (${mb(bytes.length)})`);
}

const manifestFile = path.join(outDir, 'manifest.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { models: {} };
manifest.version = 1;
manifest.models ??= {};
fs.mkdirSync(outDir, { recursive: true });

for (const model of models) {
    if (only && model.id !== only) continue;
    const started = Date.now();
    console.log(`${model.id} (${model.task}, ${model.arch}${model.scale ? `, ×${model.scale}` : ''})`);
    if (model.arch === 'onnx') {
        // ready-made ONNX files: checked and copied (hash in the name like the converted ones)
        const entry = { task: model.task, arch: model.arch, input: model.input, variants: {} };
        for (const [variant, v] of Object.entries(model.variants)) {
            const src = await fetchSource(model, v.source, v.sha256, `${model.id}.${variant}.onnx`);
            // spelled-out deformable convolutions → DeformConv, wide Concat/Split → trees (scripts/lib/onnx-rewrite.mjs)
            const fusedModel = fuseDeformConv(src);
            if (fusedModel.fused) console.log(`  ${variant}: ${fusedModel.fused} deformable convolutions fused into DeformConv`);
            // half floats: Pad in float32 (a browser rejects the runtime's 16-bit Pad shader)
            let narrowInput = fusedModel.bytes;
            if (variant === 'fp16') {
                const p32 = opsInFloat32(narrowInput, ['Pad']);
                if (p32.wrapped) console.log(`  ${variant}: ${p32.wrapped} Pad nodes run in float32`);
                narrowInput = p32.bytes;
            }
            const { bytes, concat, split, dropped } = limitNodeWidth(narrowInput);
            if (concat || split) console.log(`  ${variant}: ${concat} Concat + ${split} Split nodes narrowed to ≤ ${MAX_WIDTH} inputs/outputs, ${dropped} unused constants dropped`);
            writeVariant(entry, model, variant, bytes);
        }
        manifest.models[model.id] = entry;
        console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s`);
        continue;
    }
    const build = BUILDERS[model.arch];
    if (!build) throw new Error(`${model.id}: unknown arch "${model.arch}"`);
    const sd = readCheckpoint(await fetchSource(model, model.source, model.sha256), model.weights);
    const params = [...sd.values()].reduce((n, t) => n + t.data.length, 0);
    const entry = { task: model.task, arch: model.arch, scale: model.scale, params, variants: {} };
    for (const [variant, type] of [['fp32', FLOAT], ['fp16', FLOAT16]]) {
        const bytes = build(sd, model.scale, type).encode({
            producer: 'upscalr',
            version: CONVERTER_VERSION,
            metadata: { id: model.id, scale: model.scale, source: model.source, license: model.license, precision: variant },
        });
        writeVariant(entry, model, variant, bytes);
    }
    manifest.models[model.id] = entry;
    console.log(`  ${(params / 1e6).toFixed(2)} M parameters, ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// only models still listed; files of older conversions are removed
for (const id of Object.keys(manifest.models)) if (!models.some(m => m.id === id)) delete manifest.models[id];
const keep = new Set(Object.values(manifest.models).flatMap(m => Object.values(m.variants).map(v => v.file)));
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.onnx') && !keep.has(f)) fs.rmSync(path.join(outDir, f));
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: ${path.relative(root, manifestFile)}`);
