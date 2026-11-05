// Page side of the inference worker (docs/inference.md): starts it, knows the backend, sends jobs, hands progress and
// results back as promises. One job at a time (the worker queues anyway); a job can be cancelled between two tiles.
import type { Backend, ErrorCode, FromWorker, Manifest, Precision, Progress, RunRequest } from './types';
import { DEBUG } from './log';

export interface BackendInfo { backend: Backend; precision: Precision; adapter: string }
export interface UpscaleResult { blob: Blob; width: number; height: number; mime: string; alpha: boolean; ms: number }

export class UpscaleError extends Error {
    constructor(public code: ErrorCode, message: string) { super(message); }
}

export type WorkerNotice = Extract<FromWorker, { type: 'notice' }>;
type Job = {
    resolve: (r: UpscaleResult) => void;
    reject: (e: UpscaleError) => void;
    onProgress: (p: Progress) => void;
    onNotice: (n: WorkerNotice) => void;
};

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
            const job = this.jobs.get(msg.id);
            if (!job) return;
            if (msg.type === 'progress') job.onProgress(msg.progress);
            else if (msg.type === 'notice') job.onNotice(msg);
            else if (msg.type === 'done') {
                this.jobs.delete(msg.id);
                job.resolve({ blob: msg.blob, width: msg.width, height: msg.height, mime: msg.mime, alpha: msg.alpha, ms: msg.ms });
            } else if (msg.type === 'error') {
                this.jobs.delete(msg.id);
                job.reject(new UpscaleError(msg.code, msg.message));
            }
        };
        this.worker.onerror = e => {
            console.error('inference worker failed:', e.message);
            for (const [id, job] of this.jobs) { this.jobs.delete(id); job.reject(new UpscaleError('unknown', e.message)); }
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

    /** start a job; the bitmap is handed over to the worker (unusable here afterwards) */
    run(req: Omit<RunRequest, 'type' | 'id'>, onProgress: Job['onProgress'], onNotice: Job['onNotice']) {
        const id = this.nextId++;
        const promise = new Promise<UpscaleResult>((resolve, reject) => {
            this.jobs.set(id, { resolve, reject, onProgress, onNotice });
        });
        this.worker.postMessage({ ...req, type: 'run', id } satisfies RunRequest, [req.bitmap]);
        return { promise, cancel: () => this.worker.postMessage({ type: 'cancel', id }) };
    }
}
