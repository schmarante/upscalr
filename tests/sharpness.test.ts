// Sharpness measurement (src/scripts/sharpness.ts) and halving (src/scripts/resample.ts) without a browser: known edge
// widths, sharp vs. enlarged pictures, flat pictures, exact 2×2 averages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, edgeStats, edgeWidthAt, SOFT_RATIO, SOFT_WIDTH } from '../src/scripts/sharpness.ts';
import { halve } from '../src/scripts/resample.ts';

/** deterministic test picture: hard-edged rectangles of random grey levels on grey */
function rectangles(w: number, h: number, seed = 1) {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const px = new Uint8ClampedArray(w * h * 4).fill(128);
    for (let n = 0; n < 120; n++) {
        const x0 = Math.floor(rnd() * w), y0 = Math.floor(rnd() * h), rw = 8 + Math.floor(rnd() * 60), rh = 8 + Math.floor(rnd() * 60);
        const v = Math.floor(rnd() * 256);
        for (let y = y0; y < Math.min(h, y0 + rh); y++) for (let x = x0; x < Math.min(w, x0 + rw); x++) {
            const i = (y * w + x) * 4;
            px[i] = px[i + 1] = px[i + 2] = v;
        }
    }
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    return px;
}

/** ×2 bilinear enlargement (a picture with detail for half its size) */
function enlarge(src: Uint8ClampedArray, w: number, h: number) {
    const ow = 2 * w, oh = 2 * h, out = new Uint8ClampedArray(ow * oh * 4);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const fx = Math.min(Math.max((x + 0.5) / 2 - 0.5, 0), w - 1), fy = Math.min(Math.max((y + 0.5) / 2 - 0.5, 0), h - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1), ax = fx - x0, ay = fy - y0;
        for (let c = 0; c < 4; c++) {
            const p = (xx: number, yy: number) => src[(yy * w + xx) * 4 + c];
            out[(y * ow + x) * 4 + c] = (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay) + (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
        }
    }
    return out;
}

const measure = (px: Uint8ClampedArray, w: number, h: number) => {
    const half = halve(px, w, h);
    return classify(edgeStats(px, w, h), edgeStats(half.rgba, half.w, half.h));
};

test('edge width of a linear ramp: 10–90 % of its length', () => {
    const w = 64, h = 8, y = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) y[r * w + x] = Math.min(200, Math.max(20, 20 + ((x - 29) * 180) / 6));
    const width = edgeWidthAt(y, w, h, 32, 4, 1, 0);
    assert.ok(Math.abs(width - 4.8) < 0.3, `width ${width}`);
});

test('hard edges are sharp, the same picture enlarged ×2 is soft', () => {
    const w = 512, h = 384;
    const sharp = measure(rectangles(w, h), w, h);
    assert.equal(sharp.soft, false, JSON.stringify(sharp));
    assert.ok(sharp.width < SOFT_WIDTH, `sharp width ${sharp.width}`);
    const soft = measure(enlarge(rectangles(w / 2, h / 2), w / 2, h / 2), w, h);
    assert.equal(soft.soft, true, JSON.stringify(soft));
    assert.ok(soft.width / soft.halfWidth >= SOFT_RATIO);
});

test('a flat picture has no edges and counts as sharp', () => {
    const w = 256, h = 256;
    const flat = new Uint8ClampedArray(w * h * 4).fill(140);
    const r = measure(flat, w, h);
    assert.equal(r.soft, false);
    assert.ok(Number.isNaN(r.width));
});

test('halve: exact 2×2 averages, odd sizes round up', () => {
    const w = 3, h = 3, px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.fill(i * 10, i * 4, i * 4 + 4);   // values 0, 10, … 80
    const r = halve(px, w, h);
    assert.equal(r.w, 2);
    assert.equal(r.h, 2);
    assert.equal(r.rgba[0], 20);                    // (0 + 10 + 30 + 40) / 4
    assert.equal(r.rgba[4], 35);                    // (20 + 20 + 50 + 50) / 4: last column with itself
    assert.equal(r.rgba[(1 * 2 + 1) * 4], 80);      // corner pixel alone
});
