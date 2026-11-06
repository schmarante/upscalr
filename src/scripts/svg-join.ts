// Joins sibling stroke-only shapes of an icon into one <path> (last step of normalizeSvg in icons.ts).
//
// Why: an icon in a translucent colour (text-white/35, or the text-white/70 of a button it inherits) shows its overlaps
// brighter – every element is painted on its own, so where the frame and a line meet, the colour is applied twice. The
// stroke of one path is painted in one go (overlapping subpaths do not add up), so runs of sibling shapes with the same
// attributes become one path; rect, circle, ellipse, line, polyline and polygon are written as path data. Left alone:
// filled shapes (subpaths of one fill can cancel each other out), dashes (the pattern would start elsewhere), shapes with
// any other attribute (transform, filter, clip-path, …) and shapes outside plain svg/g nesting (defs, mask, …).
// Plain string work like normalizeSvg (the same code runs in .astro files at build time).

const GEOMETRY: Record<string, string[]> = {
    path: ['d'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry'], circle: ['cx', 'cy', 'r'],
    ellipse: ['cx', 'cy', 'rx', 'ry'], line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'], polygon: ['points'],
};
/** attributes allowed besides the geometry – equal within a run */
const PAINT = new Set(['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-opacity', 'opacity']);
const SIZES = new Set(['width', 'height', 'r', 'rx', 'ry']);
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
const fmt = (v: number) => String(+v.toFixed(4));

/** path data of a shape ('' = draws nothing, null = cannot be converted) */
function pathData(tag: string, a: Record<string, string>): string | null {
    if (tag === 'path') return (a.d ?? '').trim();
    if (tag === 'polyline' || tag === 'polygon') {
        const p = (a.points ?? '').trim();
        if (!/^[\d\s,.eE+-]*$/.test(p)) return null;
        return p ? `M${p}${tag === 'polygon' ? 'z' : ''}` : '';
    }
    const n: Record<string, number> = {};
    for (const k of GEOMETRY[tag]) {
        const v = a[k];
        if (v === undefined || v === 'auto') continue;   // auto radius: the other one
        if (!NUM.test(v)) return null;                   // units, percentages
        n[k] = +v;
        if (n[k] < 0 && SIZES.has(k)) return null;       // invalid – the browser has its own rules for it
    }
    const g = (k: string) => n[k] ?? 0;
    if (tag === 'line') return `M${fmt(g('x1'))} ${fmt(g('y1'))}L${fmt(g('x2'))} ${fmt(g('y2'))}`;
    if (tag === 'circle' || tag === 'ellipse') {
        const cx = g('cx'), cy = g('cy');
        const rx = tag === 'circle' ? g('r') : n.rx ?? n.ry ?? 0, ry = tag === 'circle' ? g('r') : n.ry ?? n.rx ?? 0;
        if (rx <= 0 || ry <= 0) return '';
        // starts at the right like the shape itself (where a dash pattern or marker would begin)
        const arc = `A${fmt(rx)} ${fmt(ry)} 0 0 1 `;
        return `M${fmt(cx + rx)} ${fmt(cy)}${arc}${fmt(cx - rx)} ${fmt(cy)}${arc}${fmt(cx + rx)} ${fmt(cy)}z`;
    }
    // rect: corner radii as the shape draws them (missing one = the other, at most half the side)
    const x = g('x'), y = g('y'), w = g('width'), h = g('height');
    if (w <= 0 || h <= 0) return '';
    const rx = Math.min(n.rx ?? n.ry ?? 0, w / 2), ry = Math.min(n.ry ?? n.rx ?? 0, h / 2);
    if (rx <= 0 || ry <= 0) return `M${fmt(x)} ${fmt(y)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}z`;
    const arc = (ex: number, ey: number) => `A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(ex)} ${fmt(ey)}`;
    return `M${fmt(x + rx)} ${fmt(y)}H${fmt(x + w - rx)}${arc(x + w, y + ry)}V${fmt(y + h - ry)}${arc(x + w - rx, y + h)}`
        + `H${fmt(x + rx)}${arc(x, y + h - ry)}V${fmt(y + ry)}${arc(x + rx, y)}z`;
}

type Shape = { start: number; end: number; key: string; paint: [string, string][]; d: string };

/** join runs of sibling stroke-only shapes with equal attributes into one path (see above) */
export function joinStrokes(svg: string): string {
    // <path …></path> (empty) counts like <path …/>
    svg = svg.replace(/<(path|rect|circle|ellipse|line|polyline|polygon)((?:\s+[\w:-]+="[^"]*")*)\s*><\/\1>/g, '<$1$2/>');
    const open: { fill: string; plain: boolean }[] = [];   // inherited fill; only svg/g without dashes on the way
    const out: string[] = [];
    let copied = 0, run: Shape[] = [];
    const flush = () => {
        if (run.length > 1) {
            // a relative moveto at the start of a later piece would continue from the end of the previous one
            const d = run.map((s, i) => (i && /^m/.test(s.d) ? `M0 0${s.d}` : s.d)).join('');
            out.push(svg.slice(copied, run[0].start), `<path${run[0].paint.map(([k, v]) => ` ${k}="${v}"`).join('')} d="${d}"/>`);
            copied = run[run.length - 1].end;
        }
        run = [];
    };
    for (const m of svg.matchAll(TAG)) {
        const [text, closing, tag, attrText, selfClosing] = m;
        const start = m.index, end = start + text.length;
        if (closing) { flush(); open.pop(); continue; }
        const attrs = [...attrText.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v] as [string, string]);
        const a = Object.fromEntries(attrs);
        const parent = open.at(-1) ?? { fill: 'black', plain: true };
        const fill = (a.fill ?? parent.fill).trim().toLowerCase();
        if (!selfClosing) {
            flush();
            const dashed = a['stroke-dasharray'] !== undefined && a['stroke-dasharray'] !== 'none';
            open.push({ fill, plain: parent.plain && (tag === 'svg' || tag === 'g') && !dashed });
            continue;
        }
        const geometry = GEOMETRY[tag];
        const paint = geometry ? attrs.filter(([k]) => !geometry.includes(k)) : [];
        const d = geometry && parent.plain && fill === 'none' && paint.every(([k]) => PAINT.has(k)) ? pathData(tag, a) : null;
        if (d === null) { flush(); continue; }
        const key = JSON.stringify([...paint].sort());
        const prev = run.at(-1);
        if (prev && (prev.end !== start || prev.key !== key)) flush();
        run.push({ start, end, key, paint, d });
    }
    flush();
    out.push(svg.slice(copied));
    return out.join('');
}
