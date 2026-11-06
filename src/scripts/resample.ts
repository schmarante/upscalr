// Shrinking a picture before upscaling (docs/inference.md "Weiche Fotos"). Pure function – no DOM, testable in Node.

/**
 * Half size: every 2 × 2 block averaged (area filter, exact). An odd last column/row is averaged with itself (as if the
 * edge pixel were repeated), so the result has ⌈w/2⌉ × ⌈h/2⌉ pixels and upscaling it ×4 covers at least w·2 × h·2.
 * RGBA, alpha averaged like the colours.
 */
export function halve(rgba: Uint8ClampedArray, w: number, h: number): { rgba: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } {
    const ow = Math.ceil(w / 2), oh = Math.ceil(h / 2);
    const out = new Uint8ClampedArray(ow * oh * 4);
    for (let y = 0; y < oh; y++) {
        const r0 = 2 * y * w, r1 = Math.min(2 * y + 1, h - 1) * w;
        for (let x = 0; x < ow; x++) {
            const c0 = 2 * x, c1 = Math.min(2 * x + 1, w - 1);
            const a = (r0 + c0) * 4, b = (r0 + c1) * 4, c = (r1 + c0) * 4, d = (r1 + c1) * 4, o = (y * ow + x) * 4;
            for (let k = 0; k < 4; k++) out[o + k] = (rgba[a + k] + rgba[b + k] + rgba[c + k] + rgba[d + k] + 2) >> 2;
        }
    }
    return { rgba: out, w: ow, h: oh };
}
