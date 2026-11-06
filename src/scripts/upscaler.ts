// Page side of the inference worker (docs/inference.md): starts it, knows the backend, sends jobs, hands progress and
// results back as promises. One job at a time (the worker queues anyway); a job can be cancelled between two tiles.
import type { Backend, CutoutInput, EditMaps, ErrorCode, FromWorker, Manifest, ModelRef, Precision, Progress, RunRequest, Sharpness, ToWorker } from './types';
import { DEBUG } from './log';

export interface BackendInfo { backend: Backend; precision: Precision; adapter: string }
export interface UpscaleResult { blob: Blob; width: number; height: number; mime: string; alpha: boolean; ms: number }

export class UpscaleError extends Error {
    constructor(public code: ErrorCode, message: string) { super(message); }
}

export type WorkerNotice = Extract<FromWorker, { type: 'notice' }>;
type JobMessage = Exclude<FromWorker, { type: 'ready' } | { type: 'debug-gpu' }>;
/** receives the worker's messages for one request id; fail = the worker itself died */
type Job = { handle: (msg: JobMessage) => void; fail: (e: UpscaleError) => void };
type Callbacks = { onProgress: (p: Progress) => void; onNotice: (n: WorkerNotice) => void };
export interface EditSession { w: number; h: number; rgba: Uint8ClampedArray; base: Uint8ClampedArray }

const BASE = import.meta.env.BASE_URL;
/** absolute URL of a file below public/ */
export const publicUrl = (path: string) => new URL(`${BASE}${path}`, location.href).href;

/** public/models/manifest.json (written by npm run models) – null if the models are missing */
export async function loadManifest(): Promise<Manifest | null> {
    try {
        const res = await fetch(publicUrl('models/manifest.json'), { cache: 'no-cache' });
        if (!res.ok) return null;
        const m = (await res.json()) as Manifest;
        return m?.models && Object.keys(m.models).length ? m : null;
    } catch {
        return null;
    }
}

export class Upscaler {
    private worker: Worker;
    private jobs = new Map<number, Job>();
    private nextId = 1;
    info: BackendInfo | null = null;
    /** the backend is known (first time) or changed (WebGPU failed → CPU) */
    onBackend: (info: BackendInfo) => void = () => {};
    /** ?debug: shaders the browser rejected (also on globalThis.__upscalr.gpuErrors) */
    readonly gpuErrors: Extract<FromWorker, { type: 'debug-gpu' }>[] = [];
    readonly ready: Promise<BackendInfo>;

    constructor() {
        this.worker = new Worker(new URL('./upscale-worker.ts', import.meta.url), { type: 'module', name: 'upscalr-inference' });
        let readyResolve!: (i: BackendInfo) => void;
        this.ready = new Promise(r => (readyResolve = r));
        this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
            const msg = ev.data;
            if (msg.type === 'ready') {
                this.info = { backend: msg.backend, precision: msg.precision, adapter: msg.adapter };
                readyResolve(this.info);
                this.onBackend(this.info);
                return;
            }
            if (msg.type === 'debug-gpu') {
                this.gpuErrors.push(msg);
                console.warn(`WebGPU shader "${msg.label}" rejected, line ${msg.line}: ${msg.message}\n${msg.source}`);
                return;
            }
            this.jobs.get(msg.id)?.handle(msg);
        };
        this.worker.onerror = e => {
            console.error('inference worker failed:', e.message);
            for (const [id, job] of this.jobs) { this.jobs.delete(id); job.fail(new UpscaleError('unknown', e.message)); }
        };
        // test switches: ?backend=wasm forces the CPU backend, ?precision=fp32 the 32-bit models,
        // ?ortlog=verbose (with ?debug) logs the runtime's node placement, ?failgpu=cutout|upscale (with ?debug) simulates
        // a shader the browser rejects (tests the CPU fallback)
        const q = new URLSearchParams(location.search);
        this.worker.postMessage({
            type: 'init', ortBase: publicUrl(`ort/${__ORT_VERSION__}/`), debug: DEBUG,
            forceCpu: q.get('backend') === 'wasm', forceFp32: q.get('precision') === 'fp32', verbose: DEBUG && q.get('ortlog') === 'verbose', failGpu: DEBUG ? q.get('failgpu') ?? '' : '',
        });
    }

    private send(msg: ToWorker, transfer: Transferable[] = []) { this.worker.postMessage(msg, transfer); }

    /** a request that ends with "done" (run, apply an edit) */
    private resultJob(id: number, cb: Partial<Callbacks>) {
        return new Promise<UpscaleResult>((resolve, reject) => {
            this.jobs.set(id, {
                fail: reject,
                handle: msg => {
                    if (msg.type === 'progress') cb.onProgress?.(msg.progress);
                    else if (msg.type === 'notice') cb.onNotice?.(msg);
                    else if (msg.type === 'done') { this.jobs.delete(id); resolve({ blob: msg.blob, width: msg.width, height: msg.height, mime: msg.mime, alpha: msg.alpha, ms: msg.ms }); }
                    else if (msg.type === 'error') { this.jobs.delete(id); reject(new UpscaleError(msg.code, msg.message)); }
                },
            });
        });
    }

    /** how sharp a picture really is (sharpness.ts); the bitmap is handed over to the worker */
    analyze(bitmap: ImageBitmap) {
        const id = this.nextId++;
        return new Promise<Sharpness>((resolve, reject) => {
            this.jobs.set(id, {
                fail: reject,
                handle: msg => { if (msg.type === 'analysis') { this.jobs.delete(id); resolve(msg.sharpness); } },
            });
            this.send({ type: 'analyze', id, bitmap }, [bitmap]);
        });
    }

    /** start a job; the bitmap is handed over to the worker (unusable here afterwards) */
    run(req: Omit<RunRequest, 'type' | 'id'>, onProgress: Callbacks['onProgress'], onNotice: Callbacks['onNotice']) {
        const id = this.nextId++;
        const promise = this.resultJob(id, { onProgress, onNotice });
        this.send({ ...req, type: 'run', id } satisfies RunRequest, [req.bitmap]);
        return { promise, cancel: () => this.send({ type: 'cancel', id }) };
    }

    /**
     * Start editing the last cut-out: resolves with the work-size picture and automatic mask; the click selection loads
     * afterwards (onSelectReady, or onSelectError if it cannot be used).
     */
    editStart(encoder: ModelRef & CutoutInput, decoder: ModelRef, maxSide: number, keepUrls: string[],
        cb: Callbacks & { onSelectReady: () => void; onSelectError: (e: UpscaleError) => void }) {
        const id = this.nextId++;
        return new Promise<EditSession>((resolve, reject) => {
            let started = false;
            this.jobs.set(id, {
                fail: reject,
                handle: msg => {
                    if (msg.type === 'progress') cb.onProgress(msg.progress);
                    else if (msg.type === 'notice') cb.onNotice(msg);
                    else if (msg.type === 'edit-ready') { started = true; resolve({ w: msg.w, h: msg.h, rgba: msg.rgba, base: msg.base }); }
                    else if (msg.type === 'edit-select-ready') { this.jobs.delete(id); cb.onSelectReady(); }
                    else if (msg.type === 'error') {
                        this.jobs.delete(id);
                        const err = new UpscaleError(msg.code, msg.message);
                        if (started) cb.onSelectError(err); else reject(err);
                    }
                },
            });
            this.send({ type: 'edit-start', id, encoder, decoder, maxSide, keepUrls });
        });
    }

    /** mask (work size, 0…255) of the object at (x, y) in work coordinates */
    editClick(op: number, x: number, y: number) {
        const id = this.nextId++;
        return new Promise<Uint8ClampedArray>((resolve, reject) => {
            this.jobs.set(id, {
                fail: reject,
                handle: msg => {
                    if (msg.type === 'edit-mask') { this.jobs.delete(id); resolve(msg.mask); }
                    else if (msg.type === 'error') { this.jobs.delete(id); reject(new UpscaleError(msg.code, msg.message)); }
                },
            });
            this.send({ type: 'edit-click', id, op, x, y });
        });
    }

    /** refined preview (RGBA at work size) */
    editRefine(maps: EditMaps) {
        const id = this.nextId++;
        return new Promise<Uint8ClampedArray>((resolve, reject) => {
            this.jobs.set(id, {
                fail: reject,
                handle: msg => {
                    if (msg.type === 'edit-preview') { this.jobs.delete(id); resolve(msg.rgba); }
                    else if (msg.type === 'error') { this.jobs.delete(id); reject(new UpscaleError(msg.code, msg.message)); }
                },
            });
            this.send({ type: 'edit-refine', id, ...maps });
        });
    }

    /** the edited selection at output size → a new result */
    editApply(maps: EditMaps, grain: number, onProgress: Callbacks['onProgress']) {
        const id = this.nextId++;
        const promise = this.resultJob(id, { onProgress });
        this.send({ type: 'edit-apply', id, grain, ...maps });
        return promise;
    }

    /** the last result with another grain (0…1) – only written again, not upscaled */
    regrain(amount: number, onProgress: Callbacks['onProgress']) {
        const id = this.nextId++;
        const promise = this.resultJob(id, { onProgress });
        this.send({ type: 'grain', id, amount });
        return promise;
    }
}
