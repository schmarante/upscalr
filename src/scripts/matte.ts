// Edge refinement of a cut-out (docs/inference.md "Freistellen – Kanten"). Pure functions on RGBA bytes – no DOM,
// testable in Node. Both steps are classic published methods, implemented here:
//
// 1. Guided filter with a colour guide (He, Sun, Tang: "Guided Image Filtering"): the mask comes from the model at
//    1024 px and is scaled up – soft, it ignores single strands. Filtered with the (upscaled) picture as guide, its
//    edges follow the real edges of the picture: strands and fly-away hair come back, gaps between curls open up.
// 2. Foreground colour estimation by blur fusion (Forte, Pitié: "Approximate Fast Foreground Colour Estimation"):
//    semi-transparent pixels still carry the old background (I = αF + (1−α)B). F is estimated from the opaque
//    surroundings and replaces the pixel colour – no halo of the old wall on a new background.
//
// Memory: everything runs in horizontal strips (with the margin the box filters need), so a 4096² picture needs a few
// dozen MB of float buffers instead of a gigabyte. Strips without any partial transparency are skipped.

/**
 * Mean over a (2r+1)² window, the window clipped at the borders. Running sums: along each row, then down the columns
 * with one running sum per column (row by row – cache-friendly, no strided access). `out` must differ from `tmp`.
 */
export function boxFilter(src: Float32Array, w: number, h: number, r: number, out: Float32Array, tmp: Float32Array) {
    const rx = Math.min(r, w - 1), ry = Math.min(r, h - 1);
    for (let y = 0; y < h; y++) {
        const o = y * w;
        let sum = 0;
        for (let x = 0; x <= rx; x++) sum += src[o + x];
        for (let x = 0; x < w; x++) {
            const lo = x - r, hi = x + r;
            tmp[o + x] = sum / ((hi < w ? hi : w - 1) - (lo > 0 ? lo : 0) + 1);
            if (hi + 1 < w) sum += src[o + hi + 1];
            if (lo >= 0) sum -= src[o + lo];
        }
    }
    const col = new Float64Array(w);
    for (let y = 0; y <= ry; y++) { const o = y * w; for (let x = 0; x < w; x++) col[x] += tmp[o + x]; }
    for (let y = 0; y < h; y++) {
        const inv = 1 / ((y + r < h ? y + r : h - 1) - (y - r > 0 ? y - r : 0) + 1), o = y * w;
        for (let x = 0; x < w; x++) out[o + x] = col[x] * inv;
        const add = y + r + 1, sub = y - r;
        if (add < h) { const oa = add * w; for (let x = 0; x < w; x++) col[x] += tmp[oa + x]; }
        if (sub >= 0) { const os = sub * w; for (let x = 0; x < w; x++) col[x] -= tmp[os + x]; }
    }
}

/** strips of `rows` rows; each with `margin` extra rows above/below (clipped) – yields [y0, y1, s0, s1] */
function* strips(h: number, rows: number, margin: number) {
    for (let y0 = 0; y0 < h; y0 += rows) {
        const y1 = Math.min(h, y0 + rows);
        yield [y0, y1, Math.max(0, y0 - margin), Math.min(h, y1 + margin)] as const;
    }
}

/** column range [x0, x1) of alpha values strictly between 0 and 255 in rows [s0, s1), or null if there are none */
function partialColumns(rgba: Uint8ClampedArray, w: number, s0: number, s1: number): [number, number] | null {
    let x0 = w, x1 = -1;
    for (let y = s0; y < s1; y++) {
        const o = y * w * 4 + 3;
        for (let x = 0; x < x0; x++) { const a = rgba[o + x * 4]; if (a !== 0 && a !== 255) { x0 = x; break; } }
        for (let x = w - 1; x > x1; x--) { const a = rgba[o + x * 4]; if (a !== 0 && a !== 255) { x1 = x; break; } }
    }
    return x1 < 0 ? null : [x0, x1 + 1];
}

/**
 * Step 1: refine the alpha channel in place with a colour-guided filter (radius r in pixels, regularisation eps on
 * 0…1 values). The RGB channels are the guide.
 */
export function guidedAlpha(rgba: Uint8ClampedArray, w: number, h: number, r: number, eps: number, stripRows = 192) {
    // q differs from p only within 2r of a partial pixel (two box levels); computing those columns needs 2r more data.
    // Rows: target rows plus 2r. Outside, q equals p exactly – those pixels are copied.
    const margin = 2 * r;
    const maxRows = Math.min(h, stripRows + 2 * margin);
    const n = maxRows * w;
    const buf = () => new Float32Array(n);
    const I = [buf(), buf(), buf()], p = buf(), mI = [buf(), buf(), buf()], mp = buf(), tmp = buf(), prod = buf();
    const cov = [buf(), buf(), buf()], v = [buf(), buf(), buf(), buf(), buf(), buf()];   // var 00 01 02 11 12 22
    const a = [buf(), buf(), buf()], b = buf();
    const result = new Uint8ClampedArray(w * h);
    for (let i = 0, d = 3; i < result.length; i++, d += 4) result[i] = rgba[d];
    for (const [y0, y1, s0, s1] of strips(h, stripRows, margin)) {
        const cols = partialColumns(rgba, w, s0, s1);
        if (!cols) continue;
        const cx0 = Math.max(0, cols[0] - 2 * margin), cx1 = Math.min(w, cols[1] + 2 * margin), cw = cx1 - cx0;
        const sh = s1 - s0, m = sh * cw;
        for (let y = 0, i = 0; y < sh; y++) {
            for (let x = cx0, s = ((s0 + y) * w + cx0) * 4; x < cx1; x++, i++, s += 4) {
                I[0][i] = rgba[s] / 255; I[1][i] = rgba[s + 1] / 255; I[2][i] = rgba[s + 2] / 255; p[i] = rgba[s + 3] / 255;
            }
        }
        const bx = (src: Float32Array, out: Float32Array) => boxFilter(src.subarray(0, m), cw, sh, r, out.subarray(0, m), tmp.subarray(0, m));
        for (let c = 0; c < 3; c++) bx(I[c], mI[c]);
        bx(p, mp);
        for (let c = 0; c < 3; c++) {
            for (let i = 0; i < m; i++) prod[i] = I[c][i] * p[i];
            bx(prod, cov[c]);
            for (let i = 0; i < m; i++) cov[c][i] -= mI[c][i] * mp[i];
        }
        const pairs = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
        pairs.forEach(([j, k], q) => {
            for (let i = 0; i < m; i++) prod[i] = I[j][i] * I[k][i];
            bx(prod, v[q]);
            for (let i = 0; i < m; i++) v[q][i] -= mI[j][i] * mI[k][i] - (j === k ? eps : 0);
        });
        // per pixel: a = Σ⁻¹ · cov (symmetric 3×3, explicit inverse), b = mean_p − a·mean_I
        for (let i = 0; i < m; i++) {
            const s00 = v[0][i], s01 = v[1][i], s02 = v[2][i], s11 = v[3][i], s12 = v[4][i], s22 = v[5][i];
            const i00 = s11 * s22 - s12 * s12, i01 = s02 * s12 - s01 * s22, i02 = s01 * s12 - s02 * s11;
            const i11 = s00 * s22 - s02 * s02, i12 = s01 * s02 - s00 * s12, i22 = s00 * s11 - s01 * s01;
            const det = s00 * i00 + s01 * i01 + s02 * i02;
            const c0 = cov[0][i], c1 = cov[1][i], c2 = cov[2][i];
            const a0 = (i00 * c0 + i01 * c1 + i02 * c2) / det;
            const a1 = (i01 * c0 + i11 * c1 + i12 * c2) / det;
            const a2 = (i02 * c0 + i12 * c1 + i22 * c2) / det;
            a[0][i] = a0; a[1][i] = a1; a[2][i] = a2;
            b[i] = mp[i] - a0 * mI[0][i] - a1 * mI[1][i] - a2 * mI[2][i];
        }
        for (let c = 0; c < 3; c++) { bx(a[c], prod); a[c].set(prod.subarray(0, m)); }
        bx(b, mp);   // mp is free now: mean of b
        for (let y = y0; y < y1; y++) {
            for (let x = cx0; x < cx1; x++) {
                const i = (y - s0) * cw + x - cx0;
                const q = a[0][i] * I[0][i] + a[1][i] * I[1][i] + a[2][i] * I[2][i] + mp[i];
                result[y * w + x] = q * 255;
            }
        }
    }
    for (let i = 0, d = 3; i < result.length; i++, d += 4) rgba[d] = result[i];
}

/**
 * Step 2: replace the colour of semi-transparent pixels by the estimated foreground colour (blur fusion, two passes:
 * radius r1 for a smooth estimate, then r2 for local detail). Opaque and fully transparent pixels stay as they are.
 */
export function estimateForeground(rgba: Uint8ClampedArray, w: number, h: number, r1: number, r2: number, stripRows = 320) {
    const margin = r1 + r2;
    const maxRows = Math.min(h, stripRows + 2 * margin);
    const n = maxRows * w;
    const buf = () => new Float32Array(n);
    const I = [buf(), buf(), buf()], al = buf(), tmp = buf(), prod = buf(), bA = buf(), bB = buf();
    const F = [buf(), buf(), buf()], B = [buf(), buf(), buf()];
    const Fh = [buf(), buf(), buf()], Bh = [buf(), buf(), buf()], F1 = [buf(), buf(), buf()], B1 = [buf(), buf(), buf()];
    const fixed: [number, number, number, number, Uint8ClampedArray][] = [];
    for (const [y0, y1, s0, s1] of strips(h, stripRows, margin)) {
        // only partial pixels change; their estimates need data within r1 + r2 (rows: margin, columns: cropped)
        const cols = partialColumns(rgba, w, y0, y1);
        if (!cols) continue;
        const cx0 = Math.max(0, cols[0] - margin), cx1 = Math.min(w, cols[1] + margin), cw = cx1 - cx0;
        const sh = s1 - s0, m = sh * cw;
        for (let y = 0, i = 0; y < sh; y++) {
            for (let x = cx0, s = ((s0 + y) * w + cx0) * 4; x < cx1; x++, i++, s += 4) {
                I[0][i] = rgba[s] / 255; I[1][i] = rgba[s + 1] / 255; I[2][i] = rgba[s + 2] / 255; al[i] = rgba[s + 3] / 255;
            }
        }
        const bx = (src: Float32Array, out: Float32Array, r: number) => boxFilter(src.subarray(0, m), cw, sh, r, out.subarray(0, m), tmp.subarray(0, m));
        // one fusion pass: F̂ = blur(F·α)/blur(α), B̂ = blur(B·(1−α))/blur(1−α), F = F̂ + α(I − αF̂ − (1−α)B̂)
        const pass = (Fin: Float32Array[], Bin: Float32Array[], r: number) => {
            bx(al, bA, r);
            for (let i = 0; i < m; i++) bB[i] = 1 - bA[i];
            for (let c = 0; c < 3; c++) {
                for (let i = 0; i < m; i++) prod[i] = Fin[c][i] * al[i];
                bx(prod, Fh[c], r);
                for (let i = 0; i < m; i++) prod[i] = Bin[c][i] * (1 - al[i]);
                bx(prod, Bh[c], r);
                for (let i = 0; i < m; i++) { Fh[c][i] /= bA[i] + 1e-5; Bh[c][i] /= bB[i] + 1e-5; }
            }
            for (let i = 0; i < m; i++) {
                const A = al[i];
                for (let c = 0; c < 3; c++) {
                    const f = Fh[c][i] + A * (I[c][i] - A * Fh[c][i] - (1 - A) * Bh[c][i]);
                    F[c][i] = f < 0 ? 0 : f > 1 ? 1 : f;
                    B[c][i] = Bh[c][i];
                }
            }
        };
        pass(I, I, r1);
        for (let c = 0; c < 3; c++) { F1[c].set(F[c].subarray(0, m)); B1[c].set(B[c].subarray(0, m)); }
        pass(F1, B1, r2);
        const rows = new Uint8ClampedArray((y1 - y0) * cw * 3);
        for (let y = y0; y < y1; y++) {
            for (let x = cx0; x < cx1; x++) {
                const i = (y - s0) * cw + x - cx0, d = ((y - y0) * cw + x - cx0) * 3;
                rows[d] = F[0][i] * 255; rows[d + 1] = F[1][i] * 255; rows[d + 2] = F[2][i] * 255;
            }
        }
        fixed.push([y0, y1, cx0, cx1, rows]);
    }
    // written at the end: every strip reads the original colours, not already estimated ones
    for (const [y0, y1, cx0, cx1, rows] of fixed) {
        for (let y = y0, j = 0; y < y1; y++) {
            for (let x = cx0, d = (y * w + cx0) * 4; x < cx1; x++, j += 3, d += 4) {
                const A = rgba[d + 3];
                if (A !== 0 && A !== 255) { rgba[d] = rows[j]; rgba[d + 1] = rows[j + 1]; rgba[d + 2] = rows[j + 2]; }
            }
        }
    }
}

export interface RefineOptions {
    /** 0…255: areas refined more strongly (edge brush) – larger window, less smoothing */
    edge?: Uint8ClampedArray;
    /** 0…255: alpha at least this (interior of keep strokes) */
    keep?: Uint8ClampedArray;
    /** 0…255: alpha at most 255 − this (interior of remove strokes) */
    remove?: Uint8ClampedArray;
    /** foreground colour estimation (off for a quick preview of the mask only) */
    colours?: boolean;
}

/** bounding box [x0, y0, x1, y1) of the non-zero values, or null */
function bbox(map: Uint8ClampedArray, w: number, h: number): [number, number, number, number] | null {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) if (map[o + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * Refinement for a mask that was scaled up by `upscale` (output size / mask resolution): guided filter (stronger where
 * `edge` says so), painted interiors applied exactly, then the foreground colours.
 */
export function refineCutout(rgba: Uint8ClampedArray, w: number, h: number, upscale: number, opts: RefineOptions = {}) {
    const r = Math.max(4, Math.round(4 * upscale));
    // strong variant only inside the edge-brush area (with margin), computed from the unrefined mask
    let strong: { x0: number; y0: number; cw: number; ch: number; alpha: Uint8ClampedArray } | null = null;
    const box = opts.edge ? bbox(opts.edge, w, h) : null;
    if (box) {
        const m = 8 * r;
        const x0 = Math.max(0, box[0] - m), y0 = Math.max(0, box[1] - m), x1 = Math.min(w, box[2] + m), y1 = Math.min(h, box[3] + m);
        const cw = x1 - x0, ch = y1 - y0;
        const crop = new Uint8ClampedArray(cw * ch * 4);
        for (let y = 0; y < ch; y++) crop.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1) * 4), y * cw * 4);
        guidedAlpha(crop, cw, ch, 2 * r, 2.5e-5);
        const alpha = new Uint8ClampedArray(cw * ch);
        for (let i = 0; i < alpha.length; i++) alpha[i] = crop[i * 4 + 3];
        strong = { x0, y0, cw, ch, alpha };
    }
    guidedAlpha(rgba, w, h, r, 1e-4);
    if (strong && opts.edge) {
        const { x0, y0, cw, ch, alpha } = strong;
        for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
                const i = (y0 + y) * w + x0 + x, e = opts.edge[i];
                if (e) rgba[i * 4 + 3] = rgba[i * 4 + 3] + (alpha[y * cw + x] - rgba[i * 4 + 3]) * (e / 255);
            }
        }
    }
    if (opts.keep || opts.remove) {
        for (let i = 0, d = 3; i < w * h; i++, d += 4) {
            if (opts.keep && opts.keep[i] > rgba[d]) rgba[d] = opts.keep[i];
            if (opts.remove && 255 - opts.remove[i] < rgba[d]) rgba[d] = 255 - opts.remove[i];
        }
    }
    if (opts.colours !== false) estimateForeground(rgba, w, h, Math.max(16, Math.round(22 * upscale)), Math.max(3, Math.round(1.5 * upscale)));
}
