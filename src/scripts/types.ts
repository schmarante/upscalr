// Messages between the page (upscaler.ts) and the inference worker (upscale-worker.ts). Docs: docs/inference.md.

export type Backend = 'webgpu' | 'wasm';
export type Precision = 'fp16' | 'fp32';

/** one model file of public/models/manifest.json */
export interface ModelFile { file: string; bytes: number; sha256: string }
export interface CutoutInput { size: number; mean: number[]; std: number[] }
export interface ManifestModel {
    task: 'upscale' | 'cutout' | 'select' | 'deblur';
    arch: string;
    /** upscale models: native scale (4) */
    scale?: number;
    params?: number;
    /** cutout model: square input size and normalisation */
    input?: CutoutInput;
    /** fp32 and fp16 – a large model only fp16 (it runs on the CPU too) */
    variants: Partial<Record<Precision, ModelFile>>;
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
    /**
     * soft photo (docs/inference.md "Weiche Fotos"): deblurring model, shrink factor before upscaling (1 or 2) and
     * where the deblurring runs – 'thorough' at full size before shrinking, 'fast' after it (¼ of the work)
     */
    sharpen: (ModelRef & { shrink: 1 | 2; mode: SharpenMode }) | null;
    /** MIME type to write (the original format) */
    mime: string;
    tile: TileSettings;
    /** tiles of the deblurring model (multiples of `multiple`) */
    sharpenTile: TileSettings & { multiple: number };
    quality: { jpeg: number; webp: number };
    /** grain 0…1 added at the end (grain.ts); can be changed afterwards without upscaling again ('grain') */
    grain: number;
    /** model URLs still in use – everything else is removed from the model cache */
    keepUrls: string[];
}

/**
 * Editing a cut-out (docs/ui.md "Auswahl bearbeiten"): all maps at the work resolution of the edit session, 0…255.
 * coarse = the selection before edge refinement; edge = areas to refine more strongly (edge brush);
 * keep/remove = interiors of the keep/remove strokes that stay exactly as painted.
 */
export interface EditMaps {
    coarse: Uint8ClampedArray;
    edge: Uint8ClampedArray;
    keep: Uint8ClampedArray;
    remove: Uint8ClampedArray;
}

export type SharpenMode = 'fast' | 'thorough';
export interface TileSettings { size: number; overlap: number; minSize: number; pad: number }
/** how sharp a picture really is (sharpness.ts) */
export interface Sharpness { soft: boolean; width: number; halfWidth: number; edges: number }

export type ToWorker =
    | { type: 'init'; ortBase: string; debug: boolean; forceCpu: boolean; forceFp32: boolean; verbose: boolean; failGpu: string }
    /** measure how sharp a picture is (on opening it) */
    | { type: 'analyze'; id: number; bitmap: ImageBitmap }
    | RunRequest
    | { type: 'cancel'; id: number }
    | { type: 'edit-start'; id: number; encoder: ModelRef & CutoutInput; decoder: ModelRef; maxSide: number; keepUrls: string[] }
    | { type: 'edit-click'; id: number; op: number; x: number; y: number }
    | ({ type: 'edit-refine'; id: number } & EditMaps)
    | ({ type: 'edit-apply'; id: number; grain: number } & EditMaps)
    /** the last result again with another grain (no upscaling) */
    | { type: 'grain'; id: number; amount: number };

export type ErrorCode = 'download' | 'model' | 'gpu-memory' | 'too-large' | 'encode' | 'cancelled' | 'unknown';

export type Progress =
    | { phase: 'download'; loaded: number; total: number }
    | { phase: 'prepare' }
    | { phase: 'cutout' }
    | { phase: 'refine' }
    | { phase: 'tiles'; done: number; total: number; tileSize: number; step: 'sharpen' | 'upscale' }
    | { phase: 'alpha' }
    | { phase: 'encode' };

export type FromWorker =
    | { type: 'ready'; backend: Backend; precision: Precision; adapter: string }
    | { type: 'progress'; id: number; progress: Progress }
    | { type: 'notice'; id: number; code: 'tile-reduced'; tileSize: number }
    | { type: 'notice'; id: number; code: 'cpu-fallback'; role: 'upscale' | 'cutout' | 'select' | 'deblur' }
    | { type: 'analysis'; id: number; sharpness: Sharpness }
    /** ?debug: a WebGPU shader the browser rejected – message and the offending source lines */
    | { type: 'debug-gpu'; label: string; message: string; line: number; source: string }
    | { type: 'done'; id: number; blob: Blob; width: number; height: number; mime: string; alpha: boolean; ms: number }
    /** edit session ready: work size, the picture and the automatic mask at that size */
    | { type: 'edit-ready'; id: number; w: number; h: number; rgba: Uint8ClampedArray; base: Uint8ClampedArray }
    /** click selection model loaded and the picture analysed – clicks answer at once now */
    | { type: 'edit-select-ready'; id: number }
    | { type: 'edit-mask'; id: number; op: number; mask: Uint8ClampedArray }
    | { type: 'edit-preview'; id: number; rgba: Uint8ClampedArray }
    | { type: 'error'; id: number; code: ErrorCode; message: string };
