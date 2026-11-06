// Tile plan and seamless blending (docs/inference.md "Tiling"). Pure functions – no DOM, testable in Node.
//
// The (mirror-padded) source is covered by equal tiles of tw × th pixels: the fewest tiles that overlap by at least
// `overlap`, spread evenly from edge to edge (no tile is cut, every network run has the same shape).
//
// Blending is done one direction at a time, which keeps every pixel continuous across tile borders:
//   1. the tiles of one row are blended side by side into a band (blendTileIntoBand) – inside the overlap with the
//      tile to the left a linear ramp runs from 0 at the tile's own border (little context there) to 1 where the left
//      tile ends;
//   2. the finished band is blended into the output the same way along y (blendBand), against the row above.
// (Blending each tile straight into the output with the product of both ramps leaves a small step in the corners of
// the overlaps – the left neighbour's share in the top band is never faded out; tests/tiling.test.ts checks this.)

export interface TilePlan {
    /** tile size in source pixels (same for every tile) */
    tw: number;
    th: number;
    /** start positions in source pixels */
    xs: number[];
    ys: number[];
}

/**
 * Start positions covering `length` with tiles of `tile` pixels overlapping by at least `overlap`: the fewest tiles
 * that reach, spread evenly (all overlaps equal ±1 px – no thin sliver tile at the end).
 */
export function starts(length: number, tile: number, overlap: number): number[] {
    if (length <= tile) return [0];
    const n = Math.ceil((length - overlap) / Math.max(1, tile - overlap));
    const span = length - tile;
    return Array.from({ length: n }, (_, i) => Math.round((i * span) / (n - 1)));
}

/**
 * `multiple`: tile sides must be multiples of it (the deblurring net halves the size four times → 16; `tile` itself is
 * one). A picture smaller than a tile gets a tile rounded up – tileInput mirrors the missing pixels.
 */
export function planTiles(width: number, height: number, tile: number, overlap: number, multiple = 1): TilePlan {
    const up = (n: number) => Math.ceil(n / multiple) * multiple;
    const tw = Math.min(tile, up(width)), th = Math.min(tile, up(height));
    return { tw, th, xs: starts(width, tw, overlap), ys: starts(height, th, overlap) };
}

/**
 * Blend weights along one axis for the tile at index i (output pixels, length = tile·scale): 1 outside the overlap with
 * the previous tile, a ramp (k + 0.5) / overlap inside it – it reaches 1 exactly where the previous tile ends.
 */
export function ramp(positions: number[], i: number, tile: number, scale: number): Float32Array {
    const n = tile * scale;
    const w = new Float32Array(n).fill(1);
    if (i === 0) return w;
    const overlap = (positions[i - 1] + tile - positions[i]) * scale;
    for (let k = 0; k < overlap && k < n; k++) w[k] = (k + 0.5) / overlap;
    return w;
}

/** mirror an index into 0…n−1 (reflection without repeating the edge pixel; clamps for tiny images) */
export function mirror(i: number, n: number): number {
    if (n === 1) return 0;
    const period = 2 * (n - 1);
    let m = ((i % period) + period) % period;
    if (m >= n) m = period - m;
    return m;
}

/**
 * Network input of one tile: float32 NCHW RGB 0…1 from RGBA bytes. (x0, y0) in padded coordinates; `pad` pixels of
 * mirrored border lie around the real image.
 */
export function tileInput(rgba: Uint8ClampedArray, width: number, height: number, pad: number, x0: number, y0: number, tw: number, th: number): Float32Array {
    const out = new Float32Array(3 * tw * th);
    const plane = tw * th;
    const k = 1 / 255;
    for (let y = 0; y < th; y++) {
        const sy = mirror(y0 + y - pad, height);
        const row = sy * width;
        for (let x = 0; x < tw; x++) {
            const s = (row + mirror(x0 + x - pad, width)) * 4;
            const d = y * tw + x;
            out[d] = rgba[s] * k;
            out[plane + d] = rgba[s + 1] * k;
            out[2 * plane + d] = rgba[s + 2] * k;
        }
    }
    return out;
}

/**
 * Network output (float32 NCHW at the model's scale) reduced to the output scale: `ratio` = modelScale / factor
 * (1 or an integer > 1); every ratio × ratio block is averaged (area filter – exact for integer ratios).
 * Returns planar RGB at the output scale, values 0…255 (not rounded).
 */
export function reduceOutput(data: Float32Array, w: number, h: number, ratio: number): { rgb: Float32Array; w: number; h: number } {
    const ow = Math.floor(w / ratio), oh = Math.floor(h / ratio);
    const plane = w * h, oplane = ow * oh;
    const rgb = new Float32Array(3 * oplane);
    const k = 255 / (ratio * ratio);
    for (let c = 0; c < 3; c++) {
        const src = c * plane, dst = c * oplane;
        if (ratio === 1) {
            for (let i = 0; i < plane; i++) rgb[dst + i] = data[src + i] * 255;
            continue;
        }
        for (let y = 0; y < oh; y++) {
            for (let x = 0; x < ow; x++) {
                let sum = 0;
                for (let dy = 0; dy < ratio; dy++) {
                    const r = src + (y * ratio + dy) * w + x * ratio;
                    for (let dx = 0; dx < ratio; dx++) sum += data[r + dx];
                }
                rgb[dst + y * ow + x] = sum * k;
            }
        }
    }
    return { rgb, w: ow, h: oh };
}

/**
 * Step 1: blend one tile (planar RGB 0…255 at output scale, size tw·s × th·s) into the band of its row
 * (RGB bytes, outW × th·s). ox = position of the tile in output pixels of the padded image; padOut = pad·s is cut off
 * left and right; wx = ramp along x (1 = overwrite).
 */
export function blendTileIntoBand(band: Uint8ClampedArray, outW: number, rgb: Float32Array, tw: number, th: number,
    ox: number, padOut: number, wx: Float32Array) {
    const plane = tw * th;
    const x0 = Math.max(0, padOut - ox), x1 = Math.min(tw, outW + padOut - ox);
    for (let y = 0; y < th; y++) {
        const row = y * outW;
        for (let x = x0; x < x1; x++) {
            const a = wx[x];
            const s = y * tw + x, d = (row + ox + x - padOut) * 3;
            const r = rgb[s], g = rgb[plane + s], b = rgb[2 * plane + s];
            if (a >= 1) {
                band[d] = r; band[d + 1] = g; band[d + 2] = b;   // Uint8ClampedArray rounds and clamps
            } else {
                band[d] = band[d] + (r - band[d]) * a;
                band[d + 1] = band[d + 1] + (g - band[d + 1]) * a;
                band[d + 2] = band[d + 2] + (b - band[d + 2]) * a;
            }
        }
    }
}

/**
 * Step 2: blend a finished band (RGB bytes, outW × bandH) into the RGBA output. oy = position of the band in output
 * pixels of the padded image; padOut is cut off at top and bottom; wy = ramp along y. Alpha stays untouched.
 */
export function blendBand(out: Uint8ClampedArray, outW: number, outH: number, band: Uint8ClampedArray, bandH: number,
    oy: number, padOut: number, wy: Float32Array) {
    for (let y = 0; y < bandH; y++) {
        const py = oy + y - padOut;
        if (py < 0 || py >= outH) continue;
        const a = wy[y];
        let s = y * outW * 3, d = py * outW * 4;
        if (a >= 1) {
            for (let x = 0; x < outW; x++, s += 3, d += 4) { out[d] = band[s]; out[d + 1] = band[s + 1]; out[d + 2] = band[s + 2]; }
        } else {
            for (let x = 0; x < outW; x++, s += 3, d += 4) {
                out[d] = out[d] + (band[s] - out[d]) * a;
                out[d + 1] = out[d + 1] + (band[s + 1] - out[d + 1]) * a;
                out[d + 2] = out[d + 2] + (band[s + 2] - out[d + 2]) * a;
            }
        }
    }
}
