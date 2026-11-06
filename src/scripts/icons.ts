// Icons of the interface: one SVG file each in src/assets/icons/ (user's wish: editable in a vector program instead of
// strings in the code). The file holds the shape; size, colour and other Tailwind classes come from the code:
// icon('close', 'size-3.5'). A new file is picked up by its name, nothing to register.
//
// Icons are one colour – the text colour of the element (currentColor). Files saved by a vector program are cleaned up
// when read (docs/ui.md): every fixed colour becomes currentColor (they come out black), a missing fill on the root
// means currentColor too (the SVG default is black), rules of an embedded <style> block are moved onto the elements
// (inline in the page they would apply to the whole document – the class names repeat from file to file), XML header,
// comments, ids, fixed width/height go. Sibling stroke-only shapes become one path, so overlaps do not show in a
// translucent colour (svg-join.ts). Plain string work (no DOMParser): the same code runs in .astro files at build time.
import { joinStrokes } from './svg-join';

const FILES = import.meta.glob<string>('../assets/icons/*.svg', { eager: true, query: '?raw', import: 'default' });

// properties kept from a style block / style attribute (presentation attributes of SVG)
const PROPS = new Set(['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'clip-rule']);
const ROOT_DROP = new Set(['id', 'class', 'style', 'width', 'height', 'x', 'y', 'version', 'xml:space', 'enable-background', 'data-name']);
const DROP = new Set(['id', 'class', 'style', 'data-name']);

const parseDecls = (text: string) => {
    const out: Record<string, string> = {};
    for (const d of text.split(';')) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
        if (PROPS.has(k)) out[k] = v;
    }
    return out;
};
/** a fixed colour → the text colour; none, currentColor, gradients/patterns (url(…)) stay */
const colour = (v: string) => /^(none|currentcolor|transparent|inherit|url\()/i.test(v) ? v : 'currentColor';
const value = (k: string, v: string) => (k === 'fill' || k === 'stroke' ? colour(v) : k === 'stroke-width' ? v.replace(/px$/, '') : v);

/** clean up the markup of an icon file (see above) */
export function normalizeSvg(text: string): string {
    let svg = text.slice(text.indexOf('<svg')).replace(/<!--[\s\S]*?-->/g, '').replace(/<title>[\s\S]*?<\/title>/g, '');
    // class rules of embedded style blocks (simple class selectors, as exported by vector programs)
    const rules = new Map<string, Record<string, string>>();
    svg = svg.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_, css: string) => {
        for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const decls = parseDecls(body);
            for (const s of sel.split(',')) {
                const m = s.trim().match(/^\.([\w-]+)$/);
                if (m) rules.set(m[1], { ...rules.get(m[1]), ...decls });
            }
        }
        return '';
    });
    svg = svg.replace(/<defs>\s*<\/defs>/g, '');
    let root = true;
    svg = svg.replace(/<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g, (_, tag: string, attrText: string, close: string) => {
        const attrs: Record<string, string> = {};
        for (const [, k, v] of attrText.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[k] = v;
        // precedence like CSS: style attribute > class rules > presentation attributes
        const styled: Record<string, string> = {};
        for (const c of (attrs.class || '').split(/\s+/)) Object.assign(styled, rules.get(c));
        Object.assign(styled, parseDecls(attrs.style || ''));
        const drop = root ? ROOT_DROP : DROP;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(attrs)) if (!drop.has(k)) out[k] = PROPS.has(k) ? value(k, v) : v;
        for (const [k, v] of Object.entries(styled)) out[k] = value(k, v);
        if (root && tag === 'svg' && !('fill' in out)) out.fill = 'currentColor';
        root = false;
        return `<${tag}${Object.entries(out).map(([k, v]) => ` ${k}="${v}"`).join('')}${close ? '/' : ''}>`;
    });
    return joinStrokes(svg.replace(/>\s+</g, '><').trim());
}

const FILE_OF = new Map(Object.entries(FILES).map(([file, text]) => [file.slice(file.lastIndexOf('/') + 1, -'.svg'.length), text]));
const ICONS = new Map<string, string>();   // name → cleaned markup (on first use)

/** SVG markup of an icon with the given classes ('' for an unknown name) */
export function icon(name: string, classes = ''): string {
    let svg = ICONS.get(name);
    if (svg === undefined) {
        const text = FILE_OF.get(name);
        if (text === undefined) { console.warn(`icon "${name}" missing in src/assets/icons`); return ''; }
        ICONS.set(name, (svg = normalizeSvg(text)));
    }
    return classes ? svg.replace('<svg', `<svg class="${classes}"`) : svg;
}
