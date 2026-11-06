// How sharp a picture really is (docs/inference.md "Weiche Fotos"): phone photos often hold detail for only half
// their pixel count (smoothed, digitally zoomed, slightly moved). Pure functions – no DOM, testable in Node.
//
// Measure: the width of strong edges. Along the gradient of the strongest edge pixels (local maxima of the gradient,
// as in edge detection) the brightness profile is followed to the dark and the bright side; the distance between the
// 10 % and 90 % rise is the edge width. A sharp photo has edges of about one to two pixels, a picture enlarged by two
// twice that. Flat areas (sky, haze) carry no edges and do not count – unlike measures over the whole picture.
// The sharper part of the edges decides (a low percentile): depth of field makes some edges soft in any photo, the
// sharpest ones show the resolution of the capture.
//
// Soft = the edges are wide AND get clearly narrower at half size (classify): a sharp photo is already at the lower
// limit of about 1.2–1.7 px and hardly changes when halved, a picture with detail for half its size loses a third.
// Measured on the test pictures (docs/inference.md): sharp originals 1.23–1.67 px / ratio 0.74–1.16, the same enlarged
// ×2 1.90–2.69 px / 1.07–1.52, the phone photo 2.15 px / 1.35. Cautious on purpose – a wrong "soft" costs detail, a
// missed one leaves things as before.

import type { Sharpness } from './types';

export interface EdgeStats {
    /** edge width in pixels (percentile `PERCENTILE` of the measured edges); NaN without enough edges */
    width: number;
    /** number of measured edges */
    edges: number;
}

const MIN_GRADIENT = 6;     // brightness levels per pixel – weaker gradients are noise or soft shading
const MIN_CONTRAST = 24;    // levels between the dark and the bright side of an edge
const MAX_EDGES = 20000;    // strongest edge pixels measured (enough for a stable percentile, bounds the time)
const REACH = 12;           // pixels followed to each side
const STEP = 0.25;          // profile sampling step (pixels)
const PERCENTILE = 0.3;
const MIN_EDGES = 200;

/** brightness (0…255) of RGBA bytes */
function luma(rgba: Uint8ClampedArray, n: number): Float32Array {
    const y = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) y[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return y;
}

/** bilinear sample, clamped to the picture */
function sample(y: Float32Array, w: number, h: number, fx: number, fy: number): number {
    const x = Math.min(Math.max(fx, 0), w - 1.001), yy = Math.min(Math.max(fy, 0), h - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(yy), ax = x - x0, ay = yy - y0;
    const i = y0 * w + x0;
    return (y[i] * (1 - ax) + y[i + 1] * ax) * (1 - ay) + (y[i + w] * (1 - ax) + y[i + w + 1] * ax) * ay;
}

/**
 * Width (10–90 % rise) of the edge through (x, y) along the unit gradient (dx, dy); NaN if it is no clean edge
 * (too little contrast, the rise does not end within REACH).
 */
export function edgeWidthAt(y: Float32Array, w: number, h: number, x: number, yy: number, dx: number, dy: number): number {
    const n = Math.round(REACH / STEP);
    const p = (t: number) => sample(y, w, h, x + t * dx, yy + t * dy);
    // follow the rise to the bright side and the fall to the dark side until the profile turns
    let hi = 0, vHi = p(0);
    for (let k = 1; k <= n; k++) { const v = p(k * STEP); if (v <= vHi) break; vHi = v; hi = k; }
    let lo = 0, vLo = p(0);
    for (let k = 1; k <= n; k++) { const v = p(-k * STEP); if (v >= vLo) break; vLo = v; lo = k; }
    if (hi === n || lo === n) return NaN;
    const contrast = vHi - vLo;
    if (contrast < MIN_CONTRAST) return NaN;
    // positions of 10 % and 90 % (linear between samples)
    const cross = (level: number) => {
        let prev = vLo, tPrev = -lo * STEP;
        for (let k = -lo + 1; k <= hi; k++) {
            const t = k * STEP, v = p(t);
            if (v >= level) return tPrev + ((level - prev) / Math.max(v - prev, 1e-6)) * (t - tPrev);
            prev = v; tPrev = t;
        }
        return hi * STEP;
    };
    return cross(vLo + 0.9 * contrast) - cross(vLo + 0.1 * contrast);
}

/** edge width of a picture (RGBA bytes, w × h) */
export function edgeStats(rgba: Uint8ClampedArray, w: number, h: number): EdgeStats {
    const y = luma(rgba, w * h);
    // gradient (Sobel, scaled to levels per pixel) and local maxima along it
    const mag = new Float32Array(w * h), gxs = new Float32Array(w * h), gys = new Float32Array(w * h);
    for (let r = 1; r < h - 1; r++) {
        for (let c = 1; c < w - 1; c++) {
            const i = r * w + c;
            const gx = (y[i - w + 1] + 2 * y[i + 1] + y[i + w + 1] - y[i - w - 1] - 2 * y[i - 1] - y[i + w - 1]) / 8;
            const gy = (y[i + w - 1] + 2 * y[i + w] + y[i + w + 1] - y[i - w - 1] - 2 * y[i - w] - y[i - w + 1]) / 8;
            gxs[i] = gx; gys[i] = gy; mag[i] = Math.hypot(gx, gy);
        }
    }
    const candidates: number[] = [];
    for (let r = 2; r < h - 2; r++) {
        for (let c = 2; c < w - 2; c++) {
            const i = r * w + c, m = mag[i];
            if (m < MIN_GRADIENT) continue;
            // neighbours along the gradient direction (4 directions)
            const a = Math.atan2(gys[i], gxs[i]);
            const q = ((Math.round(a / (Math.PI / 4)) % 4) + 4) % 4;
            const off = q === 0 ? 1 : q === 1 ? w + 1 : q === 2 ? w : w - 1;
            if (m >= mag[i - off] && m > mag[i + off]) candidates.push(i);
        }
    }
    // the strongest edge pixels
    candidates.sort((a, b) => mag[b] - mag[a]);
    const widths: number[] = [];
    for (const i of candidates.slice(0, MAX_EDGES)) {
        const m = mag[i];
        const wdt = edgeWidthAt(y, w, h, i % w, Math.floor(i / w), gxs[i] / m, gys[i] / m);
        if (Number.isFinite(wdt)) widths.push(wdt);
    }
    if (widths.length < MIN_EDGES) return { width: NaN, edges: widths.length };
    widths.sort((a, b) => a - b);
    return { width: widths[Math.floor(widths.length * PERCENTILE)], edges: widths.length };
}

/** wider edges than this (px) … */
export const SOFT_WIDTH = 1.85;
/** … that get narrower than this ratio at half size → soft */
export const SOFT_RATIO = 1.15;
/** largest region measured (centre crop): bounds time and memory for big pictures */
export const ANALYZE_SIDE = 2048;

/** soft or not, from the edge widths at full and at half size (the half picture from resample.ts halve) */
export function classify(full: EdgeStats, half: EdgeStats): Sharpness {
    const soft = Number.isFinite(full.width) && Number.isFinite(half.width) && full.width >= SOFT_WIDTH && full.width / half.width >= SOFT_RATIO;
    return { soft, width: full.width, halfWidth: half.width, edges: full.edges };
}
