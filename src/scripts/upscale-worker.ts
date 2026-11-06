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
import type { Backend, CutoutInput, ErrorCode, FromWorker, ModelRef, Precision, RunRequest, ToWorker } from './types';
import { blendBand, blendTileIntoBand, planTiles, ramp, reduceOutput, tileInput } from './tiling';
import { encodeImage } from './image-io';
import { loadModel, pruneModels } from './model-cache';
import { refineCutout } from './matte';
import { addGrain } from './grain';

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
type Role = 'upscale' | 'cutout' | 'select-encoder' | 'select-decoder';
type Entry = { url: string; session: ort.InferenceSession; bytes: Uint8Array<ArrayBuffer>; ep: Backend };
const sessions: Partial<Record<Role, Entry>> = {};
const cancelled = new Set<number>();

/**
 * The last cut-out, kept for editing (docs/ui.md "Auswahl bearbeiten"): the source pixels, the output before the mask
 * was applied (upscaled RGB, alpha = source alpha or 255) and the automatic mask – so a preview or "apply" never has
 * to upscale again.
 */
let last: {
    src: Uint8ClampedArray; w: number; h: number;
    out: Uint8ClampedArray; outW: number; outH: number;
    mask: Uint8ClampedArray; size: number;
    mime: string; quality: RunRequest['quality']; sourceAlpha: boolean;
} | null = null;
/** the running edit session: work size and picture, click selection (embeddings of the picture) */
let edit: {
    w: number; h: number; rgba: Uint8ClampedArray;
    embeddings: Promise<Record<string, ort.Tensor>> | null;
} | null = null;
/** the last result before grain (output size, final alpha) – a new grain amount only writes the file again */
let final: { rgba: Uint8ClampedArray<ArrayBuffer>; w: number; h: number; mime: string; quality: RunRequest['quality']; alpha: boolean } | null = null;
let queue: Promise<void> = Promise.resolve();

const cpuThreads = () => (scope.crossOriginIsolated ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16)) : 1);

async function init(ortBase: string, forceCpu: boolean, forceFp32: boolean) {
    ort.env.wasm.wasmPaths = ortBase;
    // runtime log only with ?ortlog=verbose – its warnings (e.g. one line per removed constant) drown everything else
    ort.env.logLevel = verbose ? 'verbose' : 'error';
    try {
        // powerPreference picks the fast GPU of a laptop with two; Chrome on Windows ignores it (the system setting
        // decides) and warns in the console every time – not asked there (Chromium only: has userAgentData)
        const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
        const options: GPURequestAdapterOptions = ua?.platform === 'Windows' ? {} : { powerPreference: 'high-performance' };
        const adapter = forceCpu ? null : await navigator.gpu?.requestAdapter(options);
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
            const session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: verbose ? 0 : 3, logVerbosityLevel: verbose ? 1 : 0 });
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
    return { session: await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: verbose ? 0 : 3, logVerbosityLevel: verbose ? 1 : 0 }), ep: 'wasm' };
}

/** move one model to the CPU for good (its WebGPU shaders are rejected by this browser) */
async function toCpu(role: Role, req: RunRequest, cause: unknown) {
    const entry = sessions[role]!;
    console.warn(`${role} model fails on WebGPU, running it on the CPU:`, cause);
    await entry.session.release();
    Object.assign(entry, await createSession(entry.bytes, true));
    post({ type: 'notice', id: req.id, code: 'cpu-fallback', role: role.startsWith('select') ? 'select' : (role as 'upscale' | 'cutout') });
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

/** a gray map (w × h) as an opaque canvas – drawable and scalable like a picture */
function maskCanvas(mask: Uint8ClampedArray, w: number, h = w) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < mask.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = mask[i]; rgba[i * 4 + 3] = 255; }
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
    return canvas;
}

/** RGBA pixels as a canvas */
function pixelCanvas(rgba: Uint8ClampedArray, w: number, h: number) {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    return canvas;
}

/** a picture scaled smoothly to w × h, as RGBA bytes */
function scaled(source: CanvasImageSource, w: number, h: number) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = canvas.height = 0;
    return data;
}

/** a gray map scaled smoothly to the output size (strips like scaleIntoAlpha) */
function scaleGray(map: Uint8ClampedArray, sw: number, sh: number, outW: number, outH: number) {
    const tmp = new Uint8ClampedArray(outW * outH * 4).fill(255);
    for (let i = 3; i < tmp.length; i += 4) tmp[i] = 0;
    scaleIntoAlpha(maskCanvas(map, sw, sh), sw, sh, 0, tmp, outW, outH, false);
    const out = new Uint8ClampedArray(outW * outH);
    for (let i = 0; i < out.length; i++) out[i] = tmp[i * 4 + 3];
    return out;
}

/** network input (NCHW, normalised) from a picture squeezed to size × size */
function normalised(source: CanvasImageSource, { size, mean, std }: CutoutInput) {
    const px = scaled(source, size, size);
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) input[c * plane + i] = (px[i * 4 + c] / 255 - mean[c]) / std[c];
    return new ort.Tensor('float32', input, [1, 3, size, size]);
}

/** grain (on a copy – `final` stays clean) and write the file */
async function encodeFinal(f: NonNullable<typeof final>, grain: number) {
    let px = f.rgba;
    if (grain > 0) {
        const t0 = performance.now();
        try {
            px = addGrain(f.rgba, new Uint8ClampedArray(f.rgba.length), f.w, f.h, grain);
        } catch {
            throw new RunError('too-large', `no memory for the grain copy of ${f.w}×${f.h}`);
        }
        log(`grain ${Math.round(grain * 100)} % in ${Math.round(performance.now() - t0)} ms`);
    }
    let blob: Blob;
    try {
        blob = await encodeImage(px, f.w, f.h, f.mime, f.alpha, f.quality);
    } catch (e) {
        throw new RunError('encode', String(e));
    }
    if (!blob.size) throw new RunError('encode', 'empty file');
    return blob;
}

async function run(req: RunRequest) {
    const started = performance.now();
    const { bitmap, factor } = req;
    // the previous result is replaced – free its memory before the new one is allocated
    last = null;
    edit = null;
    final = null;
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
            // kept for editing (before the mask is applied)
            last = { src: new Uint8ClampedArray(rgba), w, h, out: out.slice(), outW, outH, mask, size, mime: req.mime, quality: req.quality, sourceAlpha };
            edit = null;
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
        final = { rgba: out, w: outW, h: outH, mime: req.mime, quality: req.quality, alpha };
        const blob = await encodeFinal(final, req.grain);
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

// --- editing a cut-out ---

class EditError extends RunError {}

/** start: work size, picture and automatic mask at that size; the click selection loads in the background */
async function editStart(msg: Extract<ToWorker, { type: 'edit-start' }>) {
    try {
        if (!last) throw new EditError('unknown', 'nothing to edit');
        const { src, w, h, mask, size } = last;
        const s = Math.min(1, msg.maxSide / Math.max(w, h));
        const ww = Math.max(1, Math.round(w * s)), wh = Math.max(1, Math.round(h * s));
        const source = pixelCanvas(src, w, h);
        const rgba = s === 1 ? new Uint8ClampedArray(src) : scaled(source, ww, wh);
        const base = new Uint8ClampedArray(ww * wh);
        const m = scaled(maskCanvas(mask, size), ww, wh);
        for (let i = 0; i < base.length; i++) base[i] = m[i * 4];
        edit = { w: ww, h: wh, rgba, embeddings: null };
        post({ type: 'edit-ready', id: msg.id, w: ww, h: wh, rgba: rgba.slice(), base });
        // click selection: models + the picture's embeddings (the first click waits for them)
        const session = edit;
        session.embeddings = (async () => {
            const enc = await useModel('select-encoder', msg.encoder, { id: msg.id, keepUrls: msg.keepUrls } as RunRequest);
            await useModel('select-decoder', msg.decoder, { id: msg.id, keepUrls: msg.keepUrls } as RunRequest);
            const input = normalised(source, msg.encoder);
            const t0 = performance.now();
            const run = () => enc.session.run({ [enc.session.inputNames[0]]: input });
            let out: ort.InferenceSession.OnnxValueMapType;
            try {
                out = await run();
            } catch (e) {
                if (enc.ep !== 'webgpu' || !isShaderError(e)) throw e;
                await toCpu('select-encoder', { id: msg.id } as RunRequest, e);
                out = await run();
            }
            input.dispose();
            log(`selection: picture analysed in ${Math.round(performance.now() - t0)} ms (${enc.ep})`);
            // one throw-away click: the decoder's shaders are compiled now, not on the user's first click
            const t1 = performance.now();
            await decode(out as Record<string, ort.Tensor>, 0.5, 0.5, msg.id).catch(e => log('warm-up click failed', e));
            log(`selection: decoder warmed up in ${Math.round(performance.now() - t1)} ms`);
            return out as Record<string, ort.Tensor>;
        })();
        session.embeddings.then(() => post({ type: 'edit-select-ready', id: msg.id }), e => {
            console.warn('click selection unavailable:', e);
            post({ type: 'error', id: msg.id, code: e instanceof RunError ? e.code : 'model', message: String(e) });
        });
    } catch (e) {
        post({ type: 'error', id: msg.id, code: e instanceof RunError ? e.code : 'unknown', message: String(e) });
    }
}

/** one decoder run for a point given as fraction of the picture (fx, fy) */
async function decode(emb: Record<string, ort.Tensor>, fx: number, fy: number, id: number) {
    const dec = sessions['select-decoder']!;
    const size = 1024;
    const feeds: Record<string, ort.Tensor> = {
        input_points: new ort.Tensor('float32', Float32Array.from([fx * size, fy * size]), [1, 1, 1, 2]),
        input_labels: new ort.Tensor('int64', BigInt64Array.from([1n]), [1, 1, 1]),
        input_boxes: new ort.Tensor('float32', new Float32Array(0), [1, 0, 4]),
    };
    for (const name of dec.session.inputNames) if (emb[name]) feeds[name] = emb[name];
    try {
        return await dec.session.run(feeds);
    } catch (e) {
        if (dec.ep !== 'webgpu' || !isShaderError(e)) throw e;
        await toCpu('select-decoder', { id } as RunRequest, e);
        return dec.session.run(feeds);
    }
}

/** click (work coordinates) → mask of the object under it (0…255, work size), the best of the model's candidates */
async function editClick(msg: Extract<ToWorker, { type: 'edit-click' }>) {
    try {
        if (!edit?.embeddings) throw new EditError('unknown', 'no edit session');
        const { w, h } = edit;
        const emb = await edit.embeddings;
        const t0 = performance.now();
        const out = await decode(emb, (msg.x + 0.5) / w, (msg.y + 0.5) / h, msg.id);
        const iou = out.iou_scores.data as Float32Array;
        let best = 0;
        for (let i = 1; i < iou.length; i++) if (iou[i] > iou[best]) best = i;
        const [, , , mh, mw] = out.pred_masks.dims;
        const logits = (out.pred_masks.data as Float32Array).subarray(best * mh * mw, (best + 1) * mh * mw);
        // bilinear in logit space, then a steep sigmoid: smooth outline without a wide grey seam
        const mask = new Uint8ClampedArray(w * h);
        for (let y = 0; y < h; y++) {
            const fy = Math.min(mh - 1, Math.max(0, (y + 0.5) * mh / h - 0.5)), y0 = Math.floor(fy), y1 = Math.min(mh - 1, y0 + 1), ty = fy - y0;
            for (let x = 0; x < w; x++) {
                const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * mw / w - 0.5)), x0 = Math.floor(fx), x1 = Math.min(mw - 1, x0 + 1), tx = fx - x0;
                const v = (logits[y0 * mw + x0] * (1 - tx) + logits[y0 * mw + x1] * tx) * (1 - ty) + (logits[y1 * mw + x0] * (1 - tx) + logits[y1 * mw + x1] * tx) * ty;
                mask[y * w + x] = 255 / (1 + Math.exp(-2 * v));
            }
        }
        for (const t of Object.values(out)) t.dispose();
        log(`selection: click → mask in ${Math.round(performance.now() - t0)} ms`);
        post({ type: 'edit-mask', id: msg.id, op: msg.op, mask });
    } catch (e) {
        post({ type: 'error', id: msg.id, code: e instanceof RunError ? e.code : 'unknown', message: String(e) });
    }
}

/** preview at work size: picture + refined selection (colours estimated) */
function editRefine(msg: Extract<ToWorker, { type: 'edit-refine' }>) {
    try {
        if (!edit || !last) throw new EditError('unknown', 'no edit session');
        const { w, h } = edit;
        const rgba = edit.rgba.slice();
        for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = last.sourceAlpha ? (rgba[i * 4 + 3] * msg.coarse[i]) / 255 : msg.coarse[i];
        const t0 = performance.now();
        refineCutout(rgba, w, h, Math.max(w, h) / last.size, { edge: msg.edge, keep: msg.keep, remove: msg.remove });
        log(`edit preview refined in ${Math.round(performance.now() - t0)} ms`);
        post({ type: 'edit-preview', id: msg.id, rgba });
    } catch (e) {
        post({ type: 'error', id: msg.id, code: e instanceof RunError ? e.code : 'unknown', message: String(e) });
    }
}

/** apply at output size: mask scaled up, refined on the upscaled picture, written like a normal result */
async function editApply(msg: Extract<ToWorker, { type: 'edit-apply' }>) {
    const started = performance.now();
    try {
        if (!edit || !last) throw new EditError('unknown', 'no edit session');
        const { w, h } = edit;
        const { outW, outH } = last;
        post({ type: 'progress', id: msg.id, progress: { phase: 'refine' } });
        const out = last.out.slice();
        scaleIntoAlpha(maskCanvas(msg.coarse, w, h), w, h, 0, out, outW, outH, true);
        const big = (map: Uint8ClampedArray) => (map.some(v => v) ? scaleGray(map, w, h, outW, outH) : undefined);
        refineCutout(out, outW, outH, Math.max(outW, outH) / last.size, { edge: big(msg.edge), keep: big(msg.keep), remove: big(msg.remove) });
        post({ type: 'progress', id: msg.id, progress: { phase: 'encode' } });
        final = { rgba: out, w: outW, h: outH, mime: last.mime, quality: last.quality, alpha: true };
        const blob = await encodeFinal(final, msg.grain);
        post({ type: 'done', id: msg.id, blob, width: outW, height: outH, mime: blob.type || last.mime, alpha: true, ms: performance.now() - started });
    } catch (e) {
        post({ type: 'error', id: msg.id, code: e instanceof RunError ? e.code : 'encode', message: String(e) });
    }
}

/** the last result with another grain amount */
async function regrain(msg: Extract<ToWorker, { type: 'grain' }>) {
    const started = performance.now();
    try {
        if (!final) throw new RunError('unknown', 'no result to add grain to');
        post({ type: 'progress', id: msg.id, progress: { phase: 'encode' } });
        const blob = await encodeFinal(final, msg.amount);
        post({ type: 'done', id: msg.id, blob, width: final.w, height: final.h, mime: blob.type || final.mime, alpha: final.alpha, ms: performance.now() - started });
    } catch (e) {
        const err = e instanceof RunError ? e : new RunError('unknown', String(e));
        post({ type: 'error', id: msg.id, code: err.code, message: err.message });
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
    } else if (msg.type === 'edit-start') {
        queue = queue.then(() => editStart(msg));
    } else if (msg.type === 'edit-click') {
        queue = queue.then(() => editClick(msg));
    } else if (msg.type === 'edit-refine') {
        queue = queue.then(() => editRefine(msg));
    } else if (msg.type === 'edit-apply') {
        queue = queue.then(() => editApply(msg));
    } else if (msg.type === 'grain') {
        queue = queue.then(() => regrain(msg));
    }
};
