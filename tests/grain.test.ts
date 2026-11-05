// Grain (src/scripts/grain.ts): strength, neutrality, determinism. node --test tests/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGrain, GRAIN_SIGMA } from '../src/scripts/grain.ts';

const W = 256, H = 256;
const flat = (v: number, a = 255) => {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = a; }
    return px;
};
const stats = (px: Uint8ClampedArray) => {
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { s += px[i]; s2 += px[i] * px[i]; n++; }
    const mean = s / n;
    return { mean, sd: Math.sqrt(s2 / n - mean * mean) };
};

test('amount 0 copies the picture unchanged', () => {
    const src = flat(100);
    const out = addGrain(src, new Uint8ClampedArray(src.length), W, H, 0);
    assert.deepEqual(out, src);
});

test('mid grey: mean stays, deviation is the requested one', () => {
    const src = flat(128);
    const out = addGrain(src, new Uint8ClampedArray(src.length), W, H, 0.5);
    const { mean, sd } = stats(out);
    assert.ok(Math.abs(mean - 128) < 0.3, `mean ${mean}`);
    assert.ok(Math.abs(sd - 0.5 * GRAIN_SIGMA) < 0.5, `sd ${sd}`);
    assert.deepEqual(src, flat(128), 'source untouched');
});

test('monochrome, alpha untouched, weaker in shadows', () => {
    const src = flat(128, 77);
    const out = addGrain(src, new Uint8ClampedArray(src.length), W, H, 1);
    for (let i = 0; i < out.length; i += 4) {
        assert.equal(out[i], out[i + 1]);
        assert.equal(out[i], out[i + 2]);
        assert.equal(out[i + 3], 77);
    }
    const dark = stats(addGrain(flat(20), new Uint8ClampedArray(W * H * 4), W, H, 1)).sd;
    assert.ok(dark < 0.6 * stats(out).sd, `dark ${dark}`);
});

test('same picture every time, in place or into a copy', () => {
    const a = addGrain(flat(128), new Uint8ClampedArray(W * H * 4), W, H, 0.7);
    const b = flat(128);
    addGrain(b, b, W, H, 0.7);
    assert.deepEqual(a, b);
});

test('grain is soft (neighbours correlated), not single-pixel speckle', () => {
    const out = addGrain(flat(128), new Uint8ClampedArray(W * H * 4), W, H, 1);
    let c = 0, v = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        const d0 = out[i] - 128, d1 = out[i + 4] - 128;
        c += d0 * d1; v += d0 * d0;
    }
    const r = c / v;
    assert.ok(r > 0.4 && r < 0.9, `neighbour correlation ${r}`);
});
