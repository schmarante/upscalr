// Edge refinement (src/scripts/matte.ts) without a browser: strips and column cropping must give exactly the result
// of one piece; uniform masks stay unchanged; opaque/transparent pixels keep their colour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxFilter, guidedAlpha, estimateForeground } from '../src/scripts/matte.ts';

/** test picture: noise + a soft disc as mask, partial values only near the disc edge */
function picture(w: number, h: number) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, d = Math.hypot(x - w * 0.55, y - h * 0.45) - Math.min(w, h) * 0.3;
        rgba[i] = 200 * rnd(); rgba[i + 1] = x % 256; rgba[i + 2] = y % 256;
        rgba[i + 3] = 255 * Math.min(1, Math.max(0, 0.5 - d / 6));
    }
    return rgba;
}

test('box filter equals brute force', () => {
    const w = 23, h = 17, r = 4, src = Float32Array.from({ length: w * h }, (_, i) => (i * 37) % 11);
    const out = new Float32Array(w * h), tmp = new Float32Array(w * h);
    boxFilter(src, w, h, r, out, tmp);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let v = Math.max(0, y - r); v <= Math.min(h - 1, y + r); v++) for (let u = Math.max(0, x - r); u <= Math.min(w - 1, x + r); u++) { sum += src[v * w + u]; n++; }
        assert.ok(Math.abs(out[y * w + x] - sum / n) < 1e-4);
    }
});

test('guided filter: strips + cropping = one piece', () => {
    const w = 160, h = 120;
    const a = picture(w, h), b = picture(w, h);
    guidedAlpha(a, w, h, 4, 1e-4, 16);      // many small strips
    guidedAlpha(b, w, h, 4, 1e-4, 10000);   // one strip
    assert.deepEqual(a, b);
});

test('guided filter keeps a uniform mask', () => {
    const w = 64, h = 48, a = picture(w, h);
    for (let i = 3; i < a.length; i += 4) a[i] = 255;
    const before = a.slice();
    guidedAlpha(a, w, h, 4, 1e-4);
    assert.deepEqual(a, before);
});

test('foreground estimation: strips = one piece, only partial pixels change', () => {
    const w = 160, h = 120;
    const a = picture(w, h), b = picture(w, h), orig = picture(w, h);
    estimateForeground(a, w, h, 12, 3, 16);
    estimateForeground(b, w, h, 12, 3, 10000);
    assert.deepEqual(a, b);
    for (let i = 0; i < a.length; i += 4) {
        if (orig[i + 3] === 0 || orig[i + 3] === 255) assert.deepEqual([a[i], a[i + 1], a[i + 2], a[i + 3]], [orig[i], orig[i + 1], orig[i + 2], orig[i + 3]]);
        else assert.equal(a[i + 3], orig[i + 3]);
    }
});
