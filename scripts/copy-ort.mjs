// Copies the wasm binary and loader of the inference runtime (onnxruntime-web, WebGPU build with CPU fallback) to
// public/ort/<version>/ – the app points the runtime there (wasmPaths). The version in the path keeps browser caches
// apart across updates. Runs before dev and build (package.json); public/ort/ is not in git. Details: docs/inference.md.
import fs from 'node:fs';

const pkg = new URL('../node_modules/onnxruntime-web/', import.meta.url);
const { version } = JSON.parse(fs.readFileSync(new URL('package.json', pkg), 'utf8'));
const target = new URL(`../public/ort/${version}/`, import.meta.url);
const FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

const ortRoot = new URL('../public/ort/', import.meta.url);
if (fs.existsSync(ortRoot)) {
    for (const dir of fs.readdirSync(ortRoot)) if (dir !== version) fs.rmSync(new URL(dir, ortRoot), { recursive: true });
}
fs.mkdirSync(target, { recursive: true });
for (const f of FILES) {
    const src = new URL(`dist/${f}`, pkg), dst = new URL(f, target);
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
}
