/// <reference lib="webworker" />
// Inference worker (docs/inference.md): optionally removes the background (mask from the cutout model), optionally
// prepares a soft photo (deblurring network, shrinking to its real resolution), runs the upscaling network tile by tile,
// blends the tiles into the output, sets the alpha channel, writes the result file. Also measures on opening a picture
// how sharp it really is (sharpness.ts). The page stays responsive; all pixels stay in this browser.
//
// Backend: WebGPU when the browser offers an adapter (half floats when it has shader-f16), else the runtime's CPU
// backend (WebAssembly, multi-threaded when the page is cross-origin isolated). If WebGPU fails while a session is
// created, the worker switches to the CPU for good and tells the page (a new "ready"). If a model fails later because the
// browser rejects one of the runtime's shaders (seen in Firefox: "ShaderModule with 'Pad' label is invalid" in the
// cut-out model), only that model is moved to the CPU and the job continues (notice "cpu-fallback").
import * as ort from 'onnxruntime-web/webgpu';
import type { Backend, CutoutInput, ErrorCode, FromWorker, ModelRef, Precision, RunRequest, Sharpness, TileSettings, ToWorker } from './types';
import { blendBand, blendTileIntoBand, planTiles, ramp, reduceOutput, tileInput } from './tiling';
import { halve } from './resample';
import { ANALYZE_SIDE, classify, edgeStats } from './sharpness';
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
type Role = 'upscale' | 'cutout' | 'deblur' | 'select-encoder' | 'select-decoder';
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

let gpuAdapter: GPUAdapter | null = null;
let gpuDevice: GPUDevice | null = null;

/**
 * powerPreference picks the fast GPU of a laptop with two; Chrome on Windows ignores it (the system setting decides)
 * and warns in the console every time – not asked there (Chromium only: has userAgentData)
 */
function requestAdapter() {
    const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    return navigator.gpu?.requestAdapter(ua?.platform === 'Windows' ? {} : { powerPreference: 'high-performance' }) ?? null;
}

// what the runtime asks for when it creates the device itself (logged with 1.31.1 – check again after an update):
// these features if the adapter has them, these limits at the adapter's maximum
const DEVICE_FEATURES = ['timestamp-query', 'shader-f16', 'subgroups', 'subgroup-size-control'] as GPUFeatureName[];
const DEVICE_LIMITS = ['maxBindGroups', 'maxStorageBuffersPerShaderStage', 'maxStorageBufferBindingSize', 'maxBufferSize',
    'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX',
    'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension'];

/**
 * The GPU device for every WebGPU session, created here instead of by the runtime: it would request its own adapter
 * with powerPreference 'high-performance' (the console warning above, on every session). A lost device (driver reset)
 * is replaced on the next session – with a new adapter, an adapter gives only one device.
 */
async function device(): Promise<GPUDevice> {
    if (gpuDevice) return gpuDevice;
    const adapter = gpuAdapter ?? await requestAdapter();
    gpuAdapter = null;
    if (!adapter) throw new Error('no WebGPU adapter');
    const limits = adapter.limits as unknown as Record<string, number>;
    const d = await adapter.requestDevice({
        requiredFeatures: DEVICE_FEATURES.filter(f => adapter.features.has(f)),
        requiredLimits: Object.fromEntries(DEVICE_LIMITS.map(k => [k, limits[k]])),
    });
    d.lost.then(info => { log('GPU device lost', info.reason, info.message); if (gpuDevice === d) gpuDevice = null; });
    return (gpuDevice = d);
}

async function init(ortBase: string, forceCpu: boolean, forceFp32: boolean) {
    ort.env.wasm.wasmPaths = ortBase;
    // runtime log only with ?ortlog=verbose – its warnings (e.g. one line per removed constant) drown everything else
    ort.env.logLevel = verbose ? 'verbose' : 'error';
    try {
        const adapter = forceCpu ? null : await requestAdapter();
        gpuAdapter = adapter;
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
            const session = await ort.InferenceSession.create(bytes, { executionProviders: [{ name: 'webgpu', device: await device() }], graphOptimizationLevel: 'all', logSeverityLevel: verbose ? 0 : 3, logVerbosityLevel: verbose ? 1 : 0 });
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
    post({ type: 'notice', id: req.id, code: 'cpu-fallback', role: role.startsWith('select') ? 'select' : (role as 'upscale' | 'cutout' | 'deblur') });
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

/** one tiled network pass: the model's own scale, output pixels per source pixel, tile settings */
interface TileJob {
    role: 'upscale' | 'deblur';
    modelScale: number;
    factor: number;
    tiles: TileSettings & { multiple?: number };
}

/**
 * All tiles of `rgba` (w × h) into `out` (RGBA outW × outH, alpha already set; may be smaller than w·factor × h·factor –
 * the rest is cut off); throws on GPU errors so the caller can retry smaller.
 */
async function runTiles(req: RunRequest, job: TileJob, session: ort.InferenceSession, rgba: Uint8ClampedArray, w: number, h: number,
    out: Uint8ClampedArray, outW: number, outH: number, tile: number) {
    const { role, modelScale, factor: s, tiles } = job;
    const ratio = modelScale / s;
    const pad = tiles.pad;
    const plan = planTiles(w + 2 * pad, h + 2 * pad, tile, tiles.overlap, tiles.multiple);
    const { tw, th, xs, ys } = plan;
    const total = xs.length * ys.length;
    const step = role === 'deblur' ? 'sharpen' : 'upscale';
    // one row of tiles is blended side by side into this band, then the band into the output (tiling.ts)
    const band = new Uint8ClampedArray(outW * th * s * 3);
    let done = 0;
    const started = performance.now();
    post({ type: 'progress', id: req.id, progress: { phase: 'tiles', done, total, tileSize: tile, step } });
    for (let r = 0; r < ys.length; r++) {
        for (let c = 0; c < xs.length; c++) {
            if (cancelled.has(req.id)) throw new RunError('cancelled');
            const wx = ramp(xs, c, tw, s);
            const input = new ort.Tensor('float32', tileInput(rgba, w, h, pad, xs[c], ys[r], tw, th), [1, 3, th, tw]);
            const t0 = debug ? performance.now() : 0;
            if (failGpu === role && sessions[role]?.ep === 'webgpu') throw new Error("simulated: ShaderModule with 'Pad' label is invalid");
            const result = await session.run({ input });
            input.dispose();
            if (debug) log(`${role} tile ${done + 1}/${total}: ${Math.round(performance.now() - t0)} ms`);
            const y = result.output;
            const reduced = reduceOutput(y.data as Float32Array, tw * modelScale, th * modelScale, ratio);
            y.dispose();
            blendTileIntoBand(band, outW, reduced.rgb, reduced.w, reduced.h, xs[c] * s, pad * s, wx);
            done++;
            post({ type: 'progress', id: req.id, progress: { phase: 'tiles', done, total, tileSize: tile, step } });
        }
        blendBand(out, outW, outH, band, th * s, ys[r] * s, pad * s, ramp(ys, r, th, s));
    }
    log(`${role}: ${total} tiles of ${tw}×${th} in ${Math.round(performance.now() - started)} ms (${sessions[role]?.ep}, ${precision})`);
}

/** a tiled pass with smaller tiles when the GPU runs out of memory, on the CPU when it rejects a shader */
async function tiled(req: RunRequest, job: TileJob, ref: ModelRef, rgba: Uint8ClampedArray, w: number, h: number,
    out: Uint8ClampedArray, outW: number, outH: number) {
    const entry = await useModel(job.role, ref, req);
    const multiple = job.tiles.multiple ?? 1;
    let tile = job.tiles.size;
    for (;;) {
        try {
            await runTiles(req, job, entry.session, rgba, w, h, out, outW, outH, tile);
            return;
        } catch (e) {
            if (e instanceof RunError) throw e;
            if (entry.ep === 'webgpu' && isShaderError(e)) {
                await toCpu(job.role, req, e);
                continue;
            }
            // most likely the GPU ran out of memory: smaller tiles with a fresh session
            if (entry.ep !== 'webgpu' || tile / 2 < job.tiles.minSize || (tile / 2) % multiple) {
                throw new RunError(entry.ep === 'webgpu' ? 'gpu-memory' : 'unknown', String(e));
            }
            console.warn(`${job.role}: tile ${tile} failed, retrying with ${tile / 2}:`, e);
            tile /= 2;
            post({ type: 'notice', id: req.id, code: 'tile-reduced', tileSize: tile });
            await entry.session.release();
            Object.assign(entry, await createSession(entry.bytes));
        }
    }
}

/** the deblurring network over a picture (same size; alpha copied) */
async function deblur(req: RunRequest, rgba: Uint8ClampedArray, w: number, h: number) {
    const out = new Uint8ClampedArray(rgba);
    await tiled(req, { role: 'deblur', modelScale: 1, factor: 1, tiles: req.sharpenTile }, req.sharpen!, rgba, w, h, out, w, h);
    return out;
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
    // a soft photo is shrunk before upscaling: the upscaler then works on a smaller picture with a larger factor
    const shrink = req.sharpen?.shrink ?? 1;
    const upFactor = factor * shrink;
    try {
        if (req.upscale && !Number.isInteger(req.upscale.scale / upFactor)) throw new RunError('unknown', `factor ${upFactor} does not divide the model scale ${req.upscale.scale}`);
        if (!req.upscale && upFactor !== 1) throw new RunError('unknown', 'no upscaling model');
        const src = new OffscreenCanvas(w, h);
        const sctx = src.getContext('2d', { willReadFrequently: true })!;
        sctx.drawImage(bitmap, 0, 0);
        const rgba = sctx.getImageData(0, 0, w, h).data;
        src.width = src.height = 0;
        let sourceAlpha = false;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { sourceAlpha = true; break; }

        const mask = req.cutout ? await cutoutMask(req, bitmap) : null;

        // soft photo: deblurring at full size ('thorough') or after shrinking ('fast', ¼ of the work)
        let pic: Uint8ClampedArray = rgba, pw = w, ph = h;
        if (req.sharpen) {
            const { mode } = req.sharpen;
            if (mode === 'thorough' || shrink === 1) pic = await deblur(req, pic, pw, ph);
            if (shrink === 2) ({ rgba: pic, w: pw, h: ph } = halve(pic, pw, ph));
            if (mode === 'fast' && shrink === 2) pic = await deblur(req, pic, pw, ph);
        }

        let out: Uint8ClampedArray<ArrayBuffer>;
        try {
            out = upFactor === 1 ? new Uint8ClampedArray(pic) : new Uint8ClampedArray(outW * outH * 4);
        } catch {
            throw new RunError('too-large', `no memory for ${outW}×${outH}`);
        }
        if (upFactor !== 1) {
            for (let i = 3; i < out.length; i += 4) out[i] = 255;
            // the shrunk picture rounds up (halve) – the output takes exactly w·factor × h·factor of it
            await tiled(req, { role: 'upscale', modelScale: req.upscale!.scale, factor: upFactor, tiles: req.tile }, req.upscale!, pic, pw, ph, out, outW, outH);
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

/** how sharp a picture really is: centre crop (at most ANALYZE_SIDE²) at full and half size (sharpness.ts) */
async function analyze(msg: Extract<ToWorker, { type: 'analyze' }>) {
    const { bitmap } = msg;
    let sharpness: Sharpness = { soft: false, width: NaN, halfWidth: NaN, edges: 0 };
    try {
        const t0 = performance.now();
        const cw = Math.min(bitmap.width, ANALYZE_SIDE), ch = Math.min(bitmap.height, ANALYZE_SIDE);
        const canvas = new OffscreenCanvas(cw, ch);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#fff';   // transparent areas as white – no edges from undefined colours
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(bitmap, (bitmap.width - cw) >> 1, (bitmap.height - ch) >> 1, cw, ch, 0, 0, cw, ch);
        const px = ctx.getImageData(0, 0, cw, ch).data;
        canvas.width = canvas.height = 0;
        const half = halve(px, cw, ch);
        sharpness = classify(edgeStats(px, cw, ch), edgeStats(half.rgba, half.w, half.h));
        log(`sharpness: edges ${sharpness.width.toFixed(2)} px, at half size ${sharpness.halfWidth.toFixed(2)} px (${sharpness.edges} edges) → ${sharpness.soft ? 'soft' : 'sharp'}, ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
        console.warn('sharpness analysis failed:', e);
    } finally {
        bitmap.close();
    }
    post({ type: 'analysis', id: msg.id, sharpness });
}

scope.onmessage = (ev: MessageEvent<ToWorker>) => {
    const msg = ev.data;
    if (msg.type === 'init') {
        debug = msg.debug;
        verbose = msg.verbose;
        failGpu = msg.failGpu;
        queue = queue.then(() => init(msg.ortBase, msg.forceCpu, msg.forceFp32));
    } else if (msg.type === 'analyze') {
        queue = queue.then(() => analyze(msg));
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
