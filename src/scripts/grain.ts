// Grain (docs/inference.md "Körnung"): fine luminance noise added after upscaling, so skin and smooth surfaces do not
// look waxy. Own implementation, pure (no DOM – testable in Node).
//
// - noise per output pixel from a hash of its position (same picture for the same amount, any processing order)
// - roughly normal (sum of four uniforms), softened with a 3×3 binomial kernel → grain of about 1.5 px instead of
//   single-pixel speckle; rescaled so the standard deviation stays `sigma`
// - the same value on R, G and B (no colour noise), weaker in deep shadows and bright highlights (like film)

/** strongest grain (amount 1): standard deviation in 0…255 steps */
export const GRAIN_SIGMA = 8;

/** a 3×3 binomial kernel scales the standard deviation of white noise by 3/8 */
const BLUR_GAIN = 8 / 3;
/** four uniforms in 0…1: mean 2, variance 1/3 */
const GAUSS_GAIN = Math.sqrt(3);

/** 32-bit integer finaliser (avalanche: every input bit flips about half the output bits) */
function mix32(h: number) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/** roughly normal noise (mean 0, deviation 1) at pixel x, y */
function gauss(x: number, y: number, seed: number) {
    const a = mix32((Math.imul(y, 0x27d4eb2d) ^ x) + seed);
    const b = mix32(a ^ 0x9e3779b9);
    const sum = (a & 0xffff) + (a >>> 16) + (b & 0xffff) + (b >>> 16);
    return (sum / 65535 - 2) * GAUSS_GAIN;
}

/** one row of noise, one pixel wider on both sides, smoothed horizontally (1 2 1) into `out` (w values) */
function noiseRow(raw: Float32Array, out: Float32Array, w: number, y: number, seed: number) {
    for (let x = -1; x <= w; x++) raw[x + 1] = gauss(x, y, seed);
    for (let x = 0; x < w; x++) out[x] = raw[x] + 2 * raw[x + 1] + raw[x + 2];
}

/**
 * Grain into `dst` (may be `src`): RGBA bytes w × h, `amount` 0…1 (0 copies). Alpha stays as it is.
 */
export function addGrain<T extends Uint8ClampedArray>(src: Uint8ClampedArray, dst: T, w: number, h: number, amount: number, seed = 1): T {
    if (dst !== src) dst.set(src);
    if (!(amount > 0)) return dst;
    const k = (amount * GRAIN_SIGMA * BLUR_GAIN) / 16;
    const raw = new Float32Array(w + 2);
    let above = new Float32Array(w), row = new Float32Array(w), below = new Float32Array(w);
    noiseRow(raw, above, w, -1, seed);
    noiseRow(raw, row, w, 0, seed);
    for (let y = 0; y < h; y++) {
        noiseRow(raw, below, w, y + 1, seed);
        for (let x = 0, d = y * w * 4; x < w; x++, d += 4) {
            const r = src[d], g = src[d + 1], b = src[d + 2];
            const l = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
            // midtones full, black and white 30 %
            const n = (above[x] + 2 * row[x] + below[x]) * k * (0.3 + 2.8 * l * (1 - l));
            dst[d] = r + n;
            dst[d + 1] = g + n;
            dst[d + 2] = b + n;
        }
        const t = above; above = row; row = below; below = t;
    }
    return dst;
}
