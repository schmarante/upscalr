/// <reference lib="webworker" />
// Inference worker (docs/inference.md): optionally removes the background (mask from the cutout model), runs the
// upscaling network tile by tile, blends the tiles into the output, sets the alpha channel, writes the result file.
// The page stays responsive; all pixels stay in this browser.
//
// Backend: WebGPU when the browser offers an adapter (half floats when it has shader-f16), else the runtime's CPU
// backend (WebAssembly, multi-threaded when the page is cross-origin isolated). If WebGPU fails while a session is
// created, the worker switches to the CPU for good and tells the page (a new "ready"). If a model fails later because the
// browser rejects one of the runtime's shaders (seen in Firefox: "ShaderModule with 'Pad' label is invalid" in the
// cut-out model), only that model is moved to the CPU and the job continues (notice "cpu-fallback").
import * as ort from 'onnxruntime-web/webgpu';
import type { Backend, ErrorCode, FromWorker, ModelRef, Precision, RunRequest, ToWorker } from './types';
import { blendBand, blendTileIntoBand, planTiles, ramp, reduceOutput, tileInput } from './tiling';
import { encodeImage } from './image-io';
import { loadModel, pruneModels } from './model-cache';
import { refineCutout } from './matte';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromWorker) => scope.postMessage(msg);

class RunError extends Error {
    constructor(public code: ErrorCode, message: string = code) { super(message); }
}

let debug = false;
let verbose = false;
let failGpu = '';   // ?debug&failgpu=<role>: the first WebGPU run of that model fails like a rejected shader
const log = (...args: unknown[]) => { if (debug) console.info('[worker]', ...args); };

let backend: Backend = 'wasm';
let precision: Precision = 'fp32';
let adapterName = '';
/** one session per task, kept for the next picture as long as the model stays the same */
type Role = 'upscale' | 'cutout';
type Entry = { url: string; session: ort.InferenceSession; bytes: Uint8Array<ArrayBuffer>; ep: Backend };
const sessions: Partial<Record<Role, Entry>> = {};
const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

const cpuThreads = () => (scope.crossOriginIsolated ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16)) : 1);

async function init(ortBase: string, forceCpu: boolean, forceFp32: boolean) {
    ort.env.wasm.wasmPaths = ortBase;
    ort.env.logLevel = debug ? 'warning' : 'error';
    try {
        const adapter = forceCpu ? null : await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        if (adapter) {
            backend = 'webgpu';
            precision = adapter.features.has('shader-f16') && !forceFp32 ? 'fp16' : 'fp32';
            const info = adapter.info;
            adapterName = [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ');
        }
    } catch (e) {
        log('no WebGPU adapter', e);
    }
    if (debug && backend === 'webgpu') watchShaders();
    // threads for the CPU backend – and with WebGPU for the nodes that stay on the CPU (the cut-out model's
    // DeformConv: 1 thread ≈ 5.4 s per mask, all cores much less – docs/inference.md)
    ort.env.wasm.numThreads = cpuThreads();
    post({ type: 'ready', backend, precision, adapter: adapterName });
}

/**
 * ?debug: report shaders the browser rejects with the message and the offending lines (the runtime only says "invalid").
 * Wraps GPUDevice.createShaderModule – the runtime creates its shaders through the JavaScript API.
 */
function watchShaders() {
    const proto = (self as unknown as { GPUDevice?: { prototype: GPUDevice } }).GPUDevice?.prototype;
    if (!proto) return;
    const create = proto.createShaderModule;
    proto.createShaderModule = function (this: GPUDevice, desc: GPUShaderModuleDescriptor) {
        const module = create.call(this, desc);
        module.getCompilationInfo().then(info => {
            for (const m of info.messages) {
                if (m.type !== 'error') continue;
                const lines = desc.code.split('\n');
                const from = Math.max(0, m.lineNum - 3);
                const source = lines.slice(from, m.lineNum + 2).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
                post({ type: 'debug-gpu', label: desc.label ?? '', message: m.message, line: m.lineNum, source });
            }
        }).catch(() => {});
        return module;
    };
}

/** a shader the browser rejects (not a memory problem) – retrying with smaller tiles would not help */
const isShaderError = (e: unknown) => /ShaderModule|compute pipeline|shader module|WGSL/i.test(String(e));

async function createSession(bytes: Uint8Array<ArrayBuffer>, cpuOnly = false): Promise<{ session: ort.InferenceSession; ep: Backend }> {
    if (backend === 'webgpu' && !cpuOnly) {
        try {
            const session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: verbose ? 0 : debug ? 2 : 3, logVerbosityLevel: verbose ? 1 : 0 });
            return { session, ep: 'webgpu' };
        } catch (e) {
            console.warn('WebGPU session failed, switching to the CPU backend:', e);
            backend = 'wasm';
            precision = 'fp32';
            ort.env.wasm.numThreads = cpuThreads();
            post({ type: 'ready', backend, precision, adapter: '' });
        }
    }
    // a half-float model also runs on the CPU (the runtime inserts conversions), only slower
    return { session: await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }), ep: 'wasm' };
}

/** move one model to the CPU for good (its WebGPU shaders are rejected by this browser) */
async function toCpu(role: Role, req: RunRequest, cause: unknown) {
    const entry = sessions[role]!;
    console.warn(`${role} model fails on WebGPU, running it on the CPU:`, cause);
    await entry.session.release();
    Object.assign(entry, await createSession(entry.bytes, true));
    post({ type: 'notice', id: req.id, code: 'cpu-fallback', role });
}

async function useModel(role: Role, ref: ModelRef, req: RunRequest): Promise<Entry> {
    const current = sessions[role];
    if (current && current.url === ref.url) return current;
    await current?.session.release();
    delete sessions[role];
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = await loadModel(ref.url, ref.bytes, (loaded, total) =>
            post({ type: 'progress', id: req.id, progress: { phase: 'download', loaded, total } }));
    } catch (e) {
        throw new RunError('download', String(e));
    }
    pruneModels(req.keepUrls);
    post({ type: 'progress', id: req.id, progress: { phase: 'prepare' } });
    let created: { session: ort.InferenceSession; ep: Backend };
    try {
        created = await createSession(bytes);
    } catch (e) {
        throw new RunError('model', String(e));
    }
    const entry: Entry = { url: ref.url, bytes, ...created };
    sessions[role] = entry;
    log('session', role, entry.ep, precision, ref.url);
    return entry;
}

/** run all tiles into `out` (RGBA, alpha already set); throws on GPU errors so the caller can retry smaller */
async function runTiles(req: RunRequest, session: ort.InferenceSession, rgba: Uint8ClampedArray, w: number, h: number, out: Uint8ClampedArray, tile: number) {
    const s = req.factor;
    const modelScale = req.upscale!.scale;
    const ratio = modelScale / s;
    const pad = req.tile.pad;
    const plan = planTiles(w + 2 * pad, h + 2 * pad, tile, req.tile.overlap);
    const { tw, th, xs, ys } = plan;
    const total = xs.length * ys.length;
    const outW = w * s, outH = h * s;
    // one row of tiles is blended side by side into this band, then the band into the output (tiling.ts)
    const band = new Uint8ClampedArray(outW * th * s * 3);
    let done = 0;
    const started = performance.now();
    post({ type: 'progress', id: req.id, progress: { phase: 'tiles', done, total, tileSize: tile } });
    for (let r = 0; r < ys.length; r++) {
        for (let c = 0; c < xs.length; c++) {
            if (cancelled.has(req.id)) throw new RunError('cancelled');
            const wx = ramp(xs, c, tw, s);
            const input = new ort.Tensor('float32', tileInput(rgba, w, h, pad, xs[c], ys[r], tw, th), [1, 3, th, tw]);
            const t0 = debug ? performance.now() : 0;
            if (failGpu === 'upscale' && sessions.upscale?.ep === 'webgpu') throw new Error("simulated: ShaderModule with 'Pad' label is invalid");
            const result = await session.run({ input });
            input.dispose();
            if (debug) log(`tile ${done + 1}/${total}: ${Math.round(performance.now() - t0)} ms`);
            const y = result.output;
            const reduced = reduceOutput(y.data as Float32Array, tw * modelScale, th * modelScale, ratio);
            y.dispose();
            blendTileIntoBand(band, outW, reduced.rgb, reduced.w, reduced.h, xs[c] * s, pad * s, wx);
            done++;
            post({ type: 'progress', id: req.id, progress: { phase: 'tiles', done, total, tileSize: tile } });
        }
        blendBand(out, outW, outH, band, th * s, ys[r] * s, pad * s, ramp(ys, r, th, s));
    }
    log(`${total} tiles of ${tw}×${th} in ${Math.round(performance.now() - started)} ms (${sessions.upscale?.ep}, ${precision})`);
}

/** upscaling with smaller tiles when the GPU runs out of memory */
async function upscale(req: RunRequest, rgba: Uint8ClampedArray, w: number, h: number, out: Uint8ClampedArray) {
    const entry = await useModel('upscale', req.upscale!, req);
    let tile = req.tile.size;
    for (;;) {
        try {
            await runTiles(req, entry.session, rgba, w, h, out, tile);
            return;
        } catch (e) {
            if (e instanceof RunError) throw e;
            if (entry.ep === 'webgpu' && isShaderError(e)) {
                await toCpu('upscale', req, e);
                continue;
            }
            // most likely the GPU ran out of memory: smaller tiles with a fresh session
            if (entry.ep !== 'webgpu' || tile / 2 < req.tile.minSize) {
                throw new RunError(entry.ep === 'webgpu' ? 'gpu-memory' : 'unknown', String(e));
            }
            console.warn(`tile ${tile} failed, retrying with ${tile / 2}:`, e);
            tile /= 2;
            post({ type: 'notice', id: req.id, code: 'tile-reduced', tileSize: tile });
            await entry.session.release();
            Object.assign(entry, await createSession(entry.bytes));
        }
    }
}

/**
 * Background removal: the whole picture squeezed to the model's square input (as in training), normalised; the output
 * (logits) becomes a mask 0…255 via the sigmoid. Returns the mask at size × size.
 */
async function cutoutMask(req: RunRequest, bitmap: ImageBitmap): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const { size, mean, std } = req.cutout!;
    const entry = await useModel('cutout', req.cutout!, req);
    if (cancelled.has(req.id)) throw new RunError('cancelled');
    post({ type: 'progress', id: req.id, progress: { phase: 'cutout' } });
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    canvas.width = canvas.height = 0;
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) input[c * plane + i] = (px[i * 4 + c] / 255 - mean[c]) / std[c];
    }
    const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
    const t0 = performance.now();
    const run = () => {
        if (failGpu === 'cutout' && entry.ep === 'webgpu') throw new Error("simulated: ShaderModule with 'Pad' label is invalid");
        return entry.session.run({ [entry.session.inputNames[0]]: tensor });
    };
    let result: ort.InferenceSession.OnnxValueMapType;
    try {
        result = await run();
    } catch (e) {
        if (entry.ep !== 'webgpu' || !isShaderError(e)) throw e;
        await toCpu('cutout', req, e);
        result = await run();
    }
    tensor.dispose();
    const y = result[entry.session.outputNames[0]];
    const logits = y.data as Float32Array;
    const mask = new Uint8ClampedArray(plane);
    for (let i = 0; i < plane; i++) mask[i] = 255 / (1 + Math.exp(-logits[i]));
    y.dispose();
    log(`cutout mask ${size}×${size} in ${Math.round(performance.now() - t0)} ms (${entry.ep}, ${precision})`);
    return mask;
}

/**
 * One channel of `source` (sw × sh) scaled smoothly by the canvas to the output and written into its alpha (or
 * multiplied into it). In strips of rows with a few source rows of margin, so no second picture at output size is
 * needed and the result equals scaling in one piece.
 */
function scaleIntoAlpha(source: CanvasImageSource, sw: number, sh: number, channel: number, out: Uint8ClampedArray, outW: number, outH: number, multiply: boolean) {
    const f = outH / sh;
    const strip = Math.max(16, Math.min(outH, Math.floor((32 << 20) / (outW * 4))));
    const margin = 4;
    const canvas = new OffscreenCanvas(outW, strip);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let y0 = 0; y0 < outH; y0 += strip) {
        const rows = Math.min(strip, outH - y0);
        const sy0 = Math.max(0, Math.floor(y0 / f) - margin);
        const sy1 = Math.min(sh, Math.ceil((y0 + rows) / f) + margin);
        ctx.clearRect(0, 0, outW, strip);
        ctx.drawImage(source, 0, sy0, sw, sy1 - sy0, 0, sy0 * f - y0, outW, (sy1 - sy0) * f);
        const a = ctx.getImageData(0, 0, outW, rows).data;
        const base = y0 * outW * 4;
        if (multiply) for (let i = 0; i < a.length; i += 4) out[base + i + 3] = (out[base + i + 3] * a[i + channel]) / 255;
        else for (let i = 0; i < a.length; i += 4) out[base + i + 3] = a[i + channel];
    }
    canvas.width = canvas.height = 0;
}

/** the mask (gray, size × size) as an opaque canvas – drawable and scalable like a picture */
function maskCanvas(mask: Uint8ClampedArray, size: number) {
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < mask.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = mask[i]; rgba[i * 4 + 3] = 255; }
    const canvas = new OffscreenCanvas(size, size);
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, size, size), 0, 0);
    return canvas;
}

async function run(req: RunRequest) {
    const started = performance.now();
    const { bitmap, factor } = req;
    const w = bitmap.width, h = bitmap.height;
    const outW = w * factor, outH = h * factor;
    try {
        if (req.upscale && !Number.isInteger(req.upscale.scale / factor)) throw new RunError('unknown', `factor ${factor} does not divide the model scale ${req.upscale.scale}`);
        if (!req.upscale && factor !== 1) throw new RunError('unknown', 'no upscaling model');
        const src = new OffscreenCanvas(w, h);
        const sctx = src.getContext('2d', { willReadFrequently: true })!;
        sctx.drawImage(bitmap, 0, 0);
        const rgba = sctx.getImageData(0, 0, w, h).data;
        src.width = src.height = 0;
        let sourceAlpha = false;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { sourceAlpha = true; break; }

        const mask = req.cutout ? await cutoutMask(req, bitmap) : null;

        let out: Uint8ClampedArray<ArrayBuffer>;
        try {
            out = factor === 1 ? new Uint8ClampedArray(rgba) : new Uint8ClampedArray(outW * outH * 4);
        } catch {
            throw new RunError('too-large', `no memory for ${outW}×${outH}`);
        }
        if (factor !== 1) {
            for (let i = 3; i < out.length; i += 4) out[i] = 255;
            await upscale(req, rgba, w, h, out);
            if (sourceAlpha) {
                post({ type: 'progress', id: req.id, progress: { phase: 'alpha' } });
                scaleIntoAlpha(bitmap, w, h, 3, out, outW, outH, false);
            }
        }
        if (mask) {
            const size = req.cutout!.size;
            scaleIntoAlpha(maskCanvas(mask, size), size, size, 0, out, outW, outH, true);
            // edges: guided filter on the picture + foreground colours (matte.ts)
            if (cancelled.has(req.id)) throw new RunError('cancelled');
            post({ type: 'progress', id: req.id, progress: { phase: 'refine' } });
            const t0 = performance.now();
            refineCutout(out, outW, outH, Math.max(outW, outH) / size);
            log(`edges refined in ${Math.round(performance.now() - t0)} ms`);
        }
        const alpha = sourceAlpha || !!mask;

        post({ type: 'progress', id: req.id, progress: { phase: 'encode' } });
        let blob: Blob;
        try {
            blob = await encodeImage(out, outW, outH, req.mime, alpha, req.quality);
        } catch (e) {
            throw new RunError('encode', String(e));
        }
        if (!blob.size) throw new RunError('encode', 'empty file');
        post({ type: 'done', id: req.id, blob, width: outW, height: outH, mime: blob.type || req.mime, alpha, ms: performance.now() - started });
    } catch (e) {
        const err = e instanceof RunError ? e : new RunError('unknown', String(e));
        if (err.code !== 'cancelled') console.warn('upscale failed:', err.code, err.message);
        post({ type: 'error', id: req.id, code: err.code, message: err.message });
    } finally {
        bitmap.close();
        cancelled.delete(req.id);
    }
}

scope.onmessage = (ev: MessageEvent<ToWorker>) => {
    const msg = ev.data;
    if (msg.type === 'init') {
        debug = msg.debug;
        verbose = msg.verbose;
        failGpu = msg.failGpu;
        queue = queue.then(() => init(msg.ortBase, msg.forceCpu, msg.forceFp32));
    } else if (msg.type === 'run') {
        queue = queue.then(() => run(msg));
    } else if (msg.type === 'cancel') {
        cancelled.add(msg.id);
    }
};
