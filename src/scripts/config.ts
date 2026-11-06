// Central settings – change them here, not in the modules that use them.

/** author data for "About" */
export const ABOUT = {
    author: 'Marco Schrenk',
    email: 'mail@marco-schrenk.de',
};

/** content types and their models (ids from scripts/models.json; the interface names them by content/quality only) */
export const CONTENT = {
    // fast photo model in three smoothing levels (how much noise and fine texture it removes; docs/models.md "blend")
    photo: { fast: { strong: 'photo-fast', medium: 'photo-fast-medium', weak: 'photo-fast-weak' }, quality: 'photo-quality' },
    drawing: 'drawing',
} as const;

/** grain after upscaling (photos): slider 0…100 % → grain.ts amount 0…1 */
export const GRAIN = { max: 100, step: 5 };

/** background removal model (id from scripts/models.json) */
export const CUTOUT = 'cutout';

/**
 * Soft photos (docs/inference.md "Weiche Fotos"): deblurring model (id from scripts/models.json) and its tiles – the
 * net halves the size four times, so tile sides are multiples of 16 (halving on low GPU memory: 384 → 192 → 96);
 * the larger overlap and border because its view reaches far (U-net).
 */
export const SHARPEN = {
    model: 'deblur',
    tile: { size: 384, overlap: 64, minSize: 64, pad: 16, multiple: 16 },
};

/**
 * Tiling (docs/inference.md): the image is processed in square tiles of `size` source pixels that overlap by at least
 * `overlap` pixels; the overlap is blended with a linear ramp, so there are no seams. Every tile has the same shape
 * (edge tiles are moved inwards instead of being cut), so the GPU compiles its shaders once.
 * `pad`: the image is mirrored by this many pixels at its border before tiling – like the training data, the
 * network then sees content instead of zero padding at the image edge.
 * If the GPU runs out of memory the tile size is halved down to `minSize`.
 */
export const TILING = {
    size: 256,
    overlap: 24,
    minSize: 64,
    pad: 8,
};

/** editing a cut-out: work size (longer side) – previews stay quick; "apply" works at output size */
export const EDIT = {
    maxSide: 1536,
};

/** quality of the lossy output formats (0…1) */
export const ENCODE = {
    jpeg: 0.95,
    webp: 0.95,
};

/**
 * Largest output the browser can still put into a canvas (2D canvas limits of current browsers: side 32767 px,
 * area 16384² px). Larger results are refused up front with a notice instead of failing at the very end.
 */
export const LIMITS = {
    maxSide: 32767,
    maxPixels: 16384 * 16384,
};

/** name of the Cache API store for the models (bump the suffix to drop all cached models) */
export const MODEL_CACHE = 'upscalr-models-v1';
