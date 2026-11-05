// Composing an edited selection (docs/ui.md "Auswahl bearbeiten"). Pure functions on 0…255 maps at work size – no DOM,
// testable in Node.
//
// The selection starts with the automatic mask; every operation in the list changes it, later ones win:
//   add / sub   – mask of a clicked object (click selection): added (max) or removed (min with its inverse)
//   keep/remove – brush strokes: painted areas become selected / unselected
//   edge        – brush strokes marking fine edges (hair, fur) for a stronger edge refinement
// Besides the coarse selection the result carries the interiors of strokes and clicked objects (keep/remove, shrunk by
// the refinement radius), which stay exactly as given after the edge refinement – without them the refinement drew faint
// outlines of a removed object back in along its picture edges – and the edge map (edge strokes plus the outlines of
// clicked objects – the click model's masks are coarse, their outlines profit most from the stronger refinement).
import type { EditMaps } from './types';

export type Op =
    | { kind: 'add' | 'sub'; mask: Uint8ClampedArray }
    | { kind: 'keep' | 'remove' | 'edge'; radius: number; points: number[] };

/** anti-aliased disc (max into the map) */
export function stampDisc(map: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, radius: number) {
    if (radius <= 0) return;
    const x0 = Math.max(0, Math.floor(cx - radius - 1)), x1 = Math.min(w - 1, Math.ceil(cx + radius + 1));
    const y0 = Math.max(0, Math.floor(cy - radius - 1)), y1 = Math.min(h - 1, Math.ceil(cy + radius + 1));
    for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - cy;
        for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - cx;
            const v = (radius - Math.sqrt(dx * dx + dy * dy) + 0.5) * 255;
            if (v <= 0) continue;
            const i = y * w + x;
            const c = v > 255 ? 255 : v;
            if (c > map[i]) map[i] = c;
        }
    }
}

/** stroke along a polyline (x, y pairs): discs every quarter radius */
export function stampStroke(map: Uint8ClampedArray, w: number, h: number, points: number[], radius: number, from = 0) {
    if (radius <= 0 || points.length < 2) return;
    const step = Math.max(0.5, radius / 4);
    if (from === 0) stampDisc(map, w, h, points[0], points[1], radius);
    for (let i = Math.max(2, from); i < points.length; i += 2) {
        const ax = points[i - 2], ay = points[i - 1], bx = points[i], by = points[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let k = 1; k <= n; k++) stampDisc(map, w, h, ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, radius);
    }
}

/** erosion with a square window of radius d (min filter) – dilation of the inverse */
function erode(map: Uint8ClampedArray, w: number, h: number, d: number) {
    if (d <= 0) return map.slice();
    const inv = new Uint8ClampedArray(map.length);
    for (let i = 0; i < map.length; i++) inv[i] = 255 - map[i];
    const out = dilate(inv, w, h, d);
    for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
    return out;
}

/** dilation with a square window of radius d (separable running max, small d) */
function dilate(map: Uint8ClampedArray, w: number, h: number, d: number) {
    if (d <= 0) return map;
    const tmp = new Uint8ClampedArray(map.length), out = new Uint8ClampedArray(map.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let m = 0;
            for (let k = Math.max(0, x - d); k <= Math.min(w - 1, x + d); k++) if (map[y * w + k] > m) m = map[y * w + k];
            tmp[y * w + x] = m;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let m = 0;
            for (let k = Math.max(0, y - d); k <= Math.min(h - 1, y + d); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
            out[y * w + x] = m;
        }
    }
    return out;
}

/** a clicked object's outline (its soft transition, widened – edge-map contribution) and its interior (shrunk by inset) */
export interface ObjectParts { rim: Uint8ClampedArray; core: Uint8ClampedArray }
export function objectParts(mask: Uint8ClampedArray, w: number, h: number, inset: number): ObjectParts {
    const band = new Uint8ClampedArray(mask.length);
    for (let i = 0; i < mask.length; i++) if (mask[i] > 8 && mask[i] < 247) band[i] = 255;
    const rim = dilate(band, w, h, Math.max(1, Math.ceil(Math.max(w, h) / 256)));
    return { rim, core: erode(mask, w, h, inset) };
}

export function emptyMaps(base: Uint8ClampedArray): EditMaps {
    const n = base.length;
    return { coarse: base.slice(), edge: new Uint8ClampedArray(n), keep: new Uint8ClampedArray(n), remove: new Uint8ClampedArray(n) };
}

/** apply one brush stroke (its full stamp and its interior stamp) to the maps, in place */
export function applyStroke(maps: EditMaps, kind: 'keep' | 'remove' | 'edge', full: Uint8ClampedArray, core: Uint8ClampedArray) {
    const { coarse, edge, keep, remove } = maps;
    for (let i = 0; i < full.length; i++) {
        const f = full[i];
        if (!f) continue;
        if (kind === 'edge') { if (f > edge[i]) edge[i] = f; continue; }
        if (kind === 'keep') {
            if (f > coarse[i]) coarse[i] = f;
            if (core[i] > keep[i]) keep[i] = core[i];
            if (255 - f < remove[i]) remove[i] = 255 - f;
        } else {
            if (255 - f < coarse[i]) coarse[i] = 255 - f;
            if (core[i] > remove[i]) remove[i] = core[i];
            if (255 - f < keep[i]) keep[i] = 255 - f;
        }
    }
}

/** apply a clicked object (add / sub) to the maps, in place (parts from objectParts()) */
export function applyObject(maps: EditMaps, kind: 'add' | 'sub', mask: Uint8ClampedArray, { rim, core }: ObjectParts) {
    const { coarse, edge, keep, remove } = maps;
    for (let i = 0; i < mask.length; i++) {
        const m = mask[i], c = core[i];
        if (kind === 'add') {
            if (m > coarse[i]) coarse[i] = m;
            if (c > keep[i]) keep[i] = c;
            if (255 - m < remove[i]) remove[i] = 255 - m;
        } else {
            if (255 - m < coarse[i]) coarse[i] = 255 - m;
            if (c > remove[i]) remove[i] = c;
            if (255 - m < keep[i]) keep[i] = 255 - m;
        }
        if (rim[i] > edge[i]) edge[i] = rim[i];
    }
}

/** the maps of an operation list (replayed from the automatic mask). inset = refinement radius at work size */
export function compose(base: Uint8ClampedArray, w: number, h: number, ops: Op[], inset: number, parts = new WeakMap<Op, ObjectParts>()): EditMaps {
    const maps = emptyMaps(base);
    const full = new Uint8ClampedArray(base.length), core = new Uint8ClampedArray(base.length);
    for (const op of ops) {
        if (op.kind === 'add' || op.kind === 'sub') {
            let p = parts.get(op);
            if (!p) { p = objectParts(op.mask, w, h, inset); parts.set(op, p); }
            applyObject(maps, op.kind, op.mask, p);
            continue;
        }
        const stroke = op as Extract<Op, { points: number[] }>;
        full.fill(0);
        core.fill(0);
        stampStroke(full, w, h, stroke.points, stroke.radius);
        if (stroke.kind !== 'edge') stampStroke(core, w, h, stroke.points, stroke.radius - inset);
        applyStroke(maps, stroke.kind, full, core);
    }
    return maps;
}
