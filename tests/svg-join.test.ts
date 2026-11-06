// Joining icon shapes (src/scripts/svg-join.ts): sibling stroke-only shapes become one path (no brighter overlaps in a
// translucent colour); filled, dashed and transformed shapes stay as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinStrokes } from '../src/scripts/svg-join.ts';

const ROOT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">';
const paths = (svg: string) => [...svg.matchAll(/<(path|rect|circle|ellipse|line|polyline|polygon)\b/g)].map(m => m[1]);

test('rect, path and circle of one stroke become one path', () => {
    const out = joinStrokes(`${ROOT}<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 11l3.5-3.5"/><circle cx="10.75" cy="5.75" r="1.25"/></svg>`);
    assert.deepEqual(paths(out), ['path']);
    assert.match(out, /^<svg[^>]*><path d="M3 2.5H13A1.5 1.5 0 0 1 14.5 4V12A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5zM1.5 11l3.5-3.5M12 5.75A1.25 1.25 0 0 1 9.5 5.75A1.25 1.25 0 0 1 12 5.75z"\/><\/svg>$/);
});

test('square rect, line, polyline and polygon as path data', () => {
    const out = joinStrokes(`${ROOT}<rect width="4" height="2"/><line x1="1" y1="2" x2="3" y2="4"/><polyline points="1,1 2,2"/><polygon points="0 0 1 0 1 1"/></svg>`);
    assert.match(out, /<path d="M0 0h4v2h-4zM1 2L3 4M1,1 2,2M0 0 1 0 1 1z"\/>/);
});

test('a later path starting with a relative moveto keeps its position', () => {
    const out = joinStrokes(`${ROOT}<path d="M1 1h2"/><path d="m5 5h2"/></svg>`);
    assert.match(out, /d="M1 1h2M0 0m5 5h2"/);
});

test('shapes with different attributes form separate runs', () => {
    const out = joinStrokes(`${ROOT}<path d="M1 1h1"/><path d="M2 2h1"/><path stroke-width="2" d="M3 3h1"/><path stroke-width="2" d="M4 4h1"/></svg>`);
    assert.match(out, /<path d="M1 1h1M2 2h1"\/><path stroke-width="2" d="M3 3h1M4 4h1"\/>/);
});

test('filled, dashed and transformed shapes stay alone', () => {
    const filled = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 0h4v4z"/><path d="M2 2h4v4z"/></svg>';
    assert.equal(joinStrokes(filled), filled);
    const dashed = `${ROOT}<rect x="1" y="1" width="4" height="4" stroke-dasharray="2 2"/><path d="M1 1h1"/><path d="M2 2h1"/></svg>`;
    assert.equal(joinStrokes(dashed), `${ROOT}<rect x="1" y="1" width="4" height="4" stroke-dasharray="2 2"/><path d="M1 1h1M2 2h1"/></svg>`);
    const moved = `${ROOT}<path d="M1 1h1" transform="rotate(45)"/><path d="M2 2h1"/></svg>`;
    assert.equal(joinStrokes(moved), moved);
});

test('fill and dashes are inherited from groups; groups split runs', () => {
    const inGroup = `${ROOT}<g fill="currentColor"><path d="M0 0h4v4z"/><path d="M2 2h4v4z"/></g></svg>`;
    assert.equal(joinStrokes(inGroup), inGroup);
    const dashedGroup = `${ROOT}<g stroke-dasharray="1 1"><path d="M1 1h1"/><path d="M2 2h1"/></g></svg>`;
    assert.equal(joinStrokes(dashedGroup), dashedGroup);
    const split = joinStrokes(`${ROOT}<path d="M1 1h1"/><g><path d="M2 2h1"/><path d="M3 3h1"/></g><path d="M4 4h1"/></svg>`);
    assert.deepEqual(paths(split), ['path', 'path', 'path']);
});

test('units, percentages and an empty closing tag', () => {
    const units = `${ROOT}<rect width="50%" height="4"/><path d="M1 1h1"/></svg>`;
    assert.equal(joinStrokes(units), units);
    assert.equal(joinStrokes(`${ROOT}<path d="M1 1h1"></path><path d="M2 2h1"></path></svg>`), `${ROOT}<path d="M1 1h1M2 2h1"/></svg>`);
});
