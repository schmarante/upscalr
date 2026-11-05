// Selection editing (src/scripts/selection.ts) without a browser: stroke stamping, order of operations, painted
// interiors, and that drawing step by step gives the same maps as replaying the operation list (undo/redo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyObject, applyStroke, compose, emptyMaps, objectParts, stampDisc, stampStroke, type Op } from '../src/scripts/selection.ts';

const W = 64, H = 48;
const base = () => { const b = new Uint8ClampedArray(W * H); for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) b[y * W + x] = 255; return b; };
const disc = (cx: number, cy: number, r: number) => { const m = new Uint8ClampedArray(W * H); stampDisc(m, W, H, cx, cy, r); return m; };

test('disc is anti-aliased and bounded', () => {
    const m = disc(32, 24, 5);
    assert.equal(m[24 * W + 32], 255);
    assert.equal(m[24 * W + 40], 0);
    const edge = m[27 * W + 35];   // on the diagonal: distance of the pixel centre ≈ 4.95
    assert.ok(edge > 0 && edge < 255, `edge value ${edge}`);
});

test('stroke covers the line between its points', () => {
    const m = new Uint8ClampedArray(W * H);
    stampStroke(m, W, H, [5, 5, 50, 5], 2);
    for (let x = 5; x <= 50; x += 5) assert.equal(m[5 * W + x], 255, `x=${x}`);
});

test('later operations win', () => {
    const obj = disc(40, 24, 6);
    const add: Op = { kind: 'add', mask: obj }, sub: Op = { kind: 'sub', mask: obj };
    assert.equal(compose(base(), W, H, [add], 2).coarse[24 * W + 40], 255);
    assert.equal(compose(base(), W, H, [add, sub], 2).coarse[24 * W + 40], 0);
    assert.equal(compose(base(), W, H, [sub, add], 2).coarse[24 * W + 40], 255);
});

test('keep/remove strokes: coarse + exact interiors, the other interior cleared', () => {
    const keep: Op = { kind: 'keep', radius: 6, points: [45, 40] };
    const remove: Op = { kind: 'remove', radius: 6, points: [20, 20] };
    const m = compose(base(), W, H, [keep, remove], 2);
    assert.equal(m.coarse[40 * W + 45], 255);
    assert.equal(m.keep[40 * W + 45], 255);
    assert.equal(m.coarse[20 * W + 20], 0);
    assert.equal(m.remove[20 * W + 20], 255);
    assert.equal(m.keep[20 * W + 20], 0);
    // interior shrunk by the inset: the stroke's rim is not exact
    assert.equal(m.keep[40 * W + 50], 0);
    assert.ok(m.coarse[40 * W + 50] > 0);
    // removing over a kept interior clears it
    const m2 = compose(base(), W, H, [keep, { kind: 'remove', radius: 8, points: [45, 40] }], 2);
    assert.equal(m2.keep[40 * W + 45], 0);
    assert.equal(m2.coarse[40 * W + 45], 0);
});

test('clicked objects: removed interior stays removed, added interior stays', () => {
    const obj = disc(40, 24, 8);
    const sub = compose(base(), W, H, [{ kind: 'add', mask: obj }, { kind: 'sub', mask: obj }], 2);
    assert.equal(sub.remove[24 * W + 40], 255);
    assert.equal(sub.keep[24 * W + 40], 0);
    const add = compose(base(), W, H, [{ kind: 'add', mask: obj }], 2);
    assert.equal(add.keep[24 * W + 40], 255);
    assert.equal(add.keep[24 * W + 47], 0);   // within the inset of the outline: not exact
});

test('edge strokes and object outlines go into the edge map only', () => {
    const m = compose(base(), W, H, [{ kind: 'edge', radius: 3, points: [10, 20] }], 2);
    assert.equal(m.edge[20 * W + 10], 255);
    assert.deepEqual(m.coarse, base());
    const soft = new Uint8ClampedArray(W * H);
    for (let i = 0; i < soft.length; i++) soft[i] = (i % W) * 4;   // a horizontal ramp
    const { rim } = objectParts(soft, W, H, 2);
    assert.ok(rim[5 * W + 30] === 255 && rim[5 * W + 0] === 0 && rim[5 * W + 63] === 0);
});

test('step by step (drawing) = replay (undo/redo)', () => {
    const ops: Op[] = [
        { kind: 'add', mask: disc(45, 20, 7) },
        { kind: 'keep', radius: 4, points: [5, 40, 20, 42, 35, 44] },
        { kind: 'sub', mask: disc(15, 15, 5) },
        { kind: 'remove', radius: 3, points: [25, 25, 28, 12] },
        { kind: 'edge', radius: 5, points: [30, 30, 50, 30] },
    ];
    const inc = emptyMaps(base());
    for (const op of ops) {
        if (op.kind === 'add' || op.kind === 'sub') { applyObject(inc, op.kind, op.mask, objectParts(op.mask, W, H, 2)); continue; }
        const st = op as Extract<Op, { points: number[] }>;
        const full = new Uint8ClampedArray(W * H), core = new Uint8ClampedArray(W * H);
        // drawn segment by segment, as the editor does while the pointer moves
        for (let n = 2; n <= st.points.length; n += 2) {
            stampStroke(full, W, H, st.points.slice(0, n), st.radius, n - 2);
            if (st.kind !== 'edge') stampStroke(core, W, H, st.points.slice(0, n), st.radius - 2, n - 2);
        }
        applyStroke(inc, st.kind, full, core);
    }
    const replay = compose(base(), W, H, ops, 2);
    assert.deepEqual(inc, replay);
});
