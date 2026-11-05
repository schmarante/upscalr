// Messages between the page (upscaler.ts) and the inference worker (upscale-worker.ts). Docs: docs/inference.md.

export type Backend = 'webgpu' | 'wasm';
export type Precision = 'fp16' | 'fp32';

/** one model file of public/models/manifest.json */
export interface ModelFile { file: string; bytes: number; sha256: string }
export interface CutoutInput { size: number; mean: number[]; std: number[] }
export interface ManifestModel {
    task: 'upscale' | 'cutout';
    arch: string;
    /** upscale models: native scale (4) */
    scale?: number;
    params?: number;
    /** cutout model: square input size and normalisation */
    input?: CutoutInput;
    variants: Record<Precision, ModelFile>;
}
/** a model file for a job: absolute URL and size (from the manifest) */
export interface ModelRef { url: string; bytes: number }
export interface Manifest { version: number; models: Record<string, ManifestModel> }

export interface RunRequest {
    type: 'run';
    id: number;
    bitmap: ImageBitmap;
    /** output scale chosen by the user (1, 2 or 4) */
    factor: number;
    /** upscaling model (null at 1×) with its native scale */
    upscale: (ModelRef & { scale: number }) | null;
    /** background removal (null = keep the background) */
    cutout: (ModelRef & CutoutInput) | null;
    /** MIME type to write (the original format) */
    mime: string;
    tile: { size: number; overlap: number; minSize: number; pad: number };
    quality: { jpeg: number; webp: number };
    /** model URLs still in use – everything else is removed from the model cache */
    keepUrls: string[];
}

export type ToWorker =
    | { type: 'init'; ortBase: string; debug: boolean; forceCpu: boolean; forceFp32: boolean; verbose: boolean; failGpu: string }
    | RunRequest
    | { type: 'cancel'; id: number };

export type ErrorCode = 'download' | 'model' | 'gpu-memory' | 'too-large' | 'encode' | 'cancelled' | 'unknown';

export type Progress =
    | { phase: 'download'; loaded: number; total: number }
    | { phase: 'prepare' }
    | { phase: 'cutout' }
    | { phase: 'refine' }
    | { phase: 'tiles'; done: number; total: number; tileSize: number }
    | { phase: 'alpha' }
    | { phase: 'encode' };

export type FromWorker =
    | { type: 'ready'; backend: Backend; precision: Precision; adapter: string }
    | { type: 'progress'; id: number; progress: Progress }
    | { type: 'notice'; id: number; code: 'tile-reduced'; tileSize: number }
    | { type: 'notice'; id: number; code: 'cpu-fallback'; role: 'upscale' | 'cutout' }
    /** ?debug: a WebGPU shader the browser rejected – message and the offending source lines */
    | { type: 'debug-gpu'; label: string; message: string; line: number; source: string }
    | { type: 'done'; id: number; blob: Blob; width: number; height: number; mime: string; alpha: boolean; ms: number }
    | { type: 'error'; id: number; code: ErrorCode; message: string };
