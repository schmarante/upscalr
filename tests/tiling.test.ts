// Tiling without a browser (npm test): with a stand-in "network" that only upscales by nearest neighbour, the tiled
// result must equal the result computed in one piece – checks indices, mirror padding, blending and the 2× reduction.
// A smooth stand-in (per-tile brightness offset) checks that blending leaves no hard seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendBand, blendTileIntoBand, mirror, planTiles, ramp, reduceOutput, starts, tileInput } from '../src/scripts/tiling.ts';

const SCALE = 4;

function image(w: number, h: number) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = (i * 37) % 256;
        rgba[i * 4 + 1] = (i * 91 + 13) % 256;
        rgba[i * 4 + 2] = (i * 53 + 101) % 256;
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

/** stand-in network: NCHW float input → nearest ×4 NCHW float output (+ offset) */
function fakeNet(input: Float32Array, tw: number, th: number, offset = 0) {
    const ow = tw * SCALE, oh = th * SCALE, out = new Float32Array(3 * ow * oh);
    for (let c = 0; c < 3; c++)
        for (let y = 0; y < oh; y++)
            for (let x = 0; x < ow; x++) out[c * ow * oh + y * ow + x] = input[c * tw * th + Math.floor(y / SCALE) * tw + Math.floor(x / SCALE)] + offset;
    return out;
}

function upscaleTiled(rgba: Uint8ClampedArray, w: number, h: number, factor: number, tile: number, overlap: number, pad: number, offsetOf = (_i: number) => 0) {
    const outW = w * factor, outH = h * factor;
    const out = new Uint8ClampedArray(outW * outH * 4).fill(255);
    const { tw, th, xs, ys } = planTiles(w + 2 * pad, h + 2 * pad, tile, overlap);
    const band = new Uint8ClampedArray(outW * th * factor * 3);
    let i = 0;
    for (let r = 0; r < ys.length; r++) {
        for (let c = 0; c < xs.length; c++) {
            const wx = ramp(xs, c, tw, factor);
            const y = fakeNet(tileInput(rgba, w, h, pad, xs[c], ys[r], tw, th), tw, th, offsetOf(i++));
            const red = reduceOutput(y, tw * SCALE, th * SCALE, SCALE / factor);
            blendTileIntoBand(band, outW, red.rgb, red.w, red.h, xs[c] * factor, pad * factor, wx);
        }
        blendBand(out, outW, outH, band, th * factor, ys[r] * factor, pad * factor, ramp(ys, r, th, factor));
    }
    return out;
}

test('starts cover the length with at least the overlap', () => {
    for (const [len, tile, ov] of [[100, 256, 24], [256, 256, 24], [257, 256, 24], [1000, 256, 24], [513, 128, 16], [300, 64, 32]]) {
        const s = starts(len, tile, ov);
        assert.equal(s[0], 0);
        assert.equal(Math.min(len, tile) + s.at(-1)!, Math.max(len, Math.min(len, tile)));
        for (let i = 1; i < s.length; i++) assert.ok(s[i - 1] + tile - s[i] >= ov - 1, `overlap ${len}/${tile}/${ov}`);
    }
});

test('mirror reflects without repeating the edge', () => {
    assert.deepEqual([-3, -2, -1, 0, 1, 4, 5, 6, 7].map(i => mirror(i, 5)), [3, 2, 1, 0, 1, 4, 3, 2, 1]);
    assert.equal(mirror(-4, 1), 0);
});

for (const factor of [4, 2]) {
    test(`tiled ×${factor} equals one piece (nearest stand-in)`, () => {
        for (const [w, h, tile] of [[37, 23, 16], [100, 61, 32], [7, 5, 64], [130, 129, 64]]) {
            const rgba = image(w, h);
            const tiled = upscaleTiled(rgba, w, h, factor, tile, 6, 4);
            const whole = upscaleTiled(rgba, w, h, factor, 4096, 0, 4);
            assert.deepEqual(tiled, whole, `${w}×${h} tile ${tile}`);
            // and equal to plain nearest upscaling of the source
            for (let y = 0; y < h * factor; y += 3) for (let x = 0; x < w * factor; x += 5) {
                const s = (Math.floor(y / factor) * w + Math.floor(x / factor)) * 4, d = (y * w * factor + x) * 4;
                assert.equal(tiled[d], rgba[s]);
            }
        }
    });
}

test('blending leaves no hard seams', () => {
    const w = 120, h = 90;
    const flat = new Uint8ClampedArray(w * h * 4).fill(128);
    // every tile is off by a different brightness (as if each tile came out slightly different)
    const out = upscaleTiled(flat, w, h, 4, 32, 8, 0, i => ((i * 7) % 5) * 0.02);
    // tiles differ by up to 0.08 (20 levels); over a ramp of 32 output pixels that is < 1 level per pixel, plus rounding
    let worst = 0;
    const W = w * 4;
    for (let y = 1; y < h * 4; y++) for (let x = 1; x < W; x++) {
        const d = (y * W + x) * 4;
        worst = Math.max(worst, Math.abs(out[d] - out[d - 4]), Math.abs(out[d] - out[d - W * 4]));
    }
    assert.ok(worst <= 2, `largest step between neighbours: ${worst}`);
});
