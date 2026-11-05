// Selection editor (docs/ui.md "Auswahl bearbeiten"): the canvas over the picture, tools, undo/redo and the preview.
// Works at the work size of the edit session; the worker refines previews (edge refinement + colours) and applies the
// result at output size. Composition rules: selection.ts.
import type { EditSession, Upscaler } from './upscaler';
import type { EditMaps } from './types';
import { applyObject, applyStroke, compose, emptyMaps, objectParts, stampStroke, type ObjectParts, type Op } from './selection';

export type Tool = 'add' | 'sub' | 'keep' | 'remove' | 'edge' | 'pan';
export const BRUSHES: Tool[] = ['keep', 'remove', 'edge'];

export interface EditorState { canUndo: boolean; canRedo: boolean; busy: boolean; selectReady: boolean; edited: boolean }

/**
 * What an applied edit leaves behind: the operation list on top of the automatic selection, at work size. Editing
 * again starts from it (non-destructive – undo goes back step by step to the automatic selection).
 */
export interface EditHistory { w: number; h: number; ops: Op[]; parts: WeakMap<Op, ObjectParts> }

const cloneMaps = (m: EditMaps): EditMaps => ({ coarse: m.coarse.slice(), edge: m.edge.slice(), keep: m.keep.slice(), remove: m.remove.slice() });

export class SelectionEditor {
    readonly canvas = document.createElement('canvas');
    readonly w: number;
    readonly h: number;
    tool: Tool = 'add';
    /** brush radius in work pixels */
    radius: number;
    /** removed areas faintly visible (to find objects to add back) */
    ghost = true;
    selectReady = false;
    onChange: (s: EditorState) => void = () => {};
    /** a message for the page (e.g. "click selection still loading") */
    onMessage: (key: string) => void = () => {};

    private ctx: CanvasRenderingContext2D;
    private image: ImageData;
    private ops: Op[] = [];
    private redoOps: Op[] = [];
    private parts = new WeakMap<Op, ObjectParts>();
    private maps: EditMaps;
    private version = 0;
    private preview: { version: number; rgba: Uint8ClampedArray } | null = null;
    private refining = false;
    private dirty = false;
    private clicks = 0;
    private nextOp = 1;
    private stroke: { kind: 'keep' | 'remove' | 'edge'; points: number[]; before: EditMaps; full: Uint8ClampedArray; core: Uint8ClampedArray } | null = null;
    private frame = 0;

    constructor(private session: EditSession, private upscaler: Upscaler, private logicalWidth: number, private inset: number, history?: EditHistory | null) {
        this.w = session.w;
        this.h = session.h;
        this.canvas.width = this.w;
        this.canvas.height = this.h;
        this.ctx = this.canvas.getContext('2d')!;
        this.image = this.ctx.createImageData(this.w, this.h);
        // the same result has the same work size – an earlier edit fits only then
        if (history && history.w === this.w && history.h === this.h && history.ops.length) {
            this.ops = history.ops.slice();
            this.parts = history.parts;
            this.maps = compose(session.base, this.w, this.h, this.ops, inset, this.parts);
        } else {
            this.maps = emptyMaps(session.base);
        }
        this.radius = Math.max(4, Math.round(Math.max(this.w, this.h) / 50));
        this.render();
        this.requestRefine();
    }

    state(): EditorState {
        return { canUndo: this.ops.length > 0, canRedo: this.redoOps.length > 0, busy: this.refining || this.clicks > 0, selectReady: this.selectReady, edited: this.ops.length > 0 };
    }
    private changed() { this.onChange(this.state()); }

    /** the operations so far, to start the next edit of the same result from (ops are never changed once made) */
    history(): EditHistory { return { w: this.w, h: this.h, ops: this.ops.slice(), parts: this.parts }; }

    /** the current maps for applying (copies) */
    current(): EditMaps { return cloneMaps(this.maps); }

    /** work pixels → screen pixels at the given zoom (screen px per logical px) */
    toScreen(zoom: number) { return (this.logicalWidth / this.w) * zoom; }

    /** pointer from the compare view (picture = logical output pixels); false = not handled (pan instead) */
    pointer = (phase: 'down' | 'move' | 'up', lx: number, ly: number, ev: PointerEvent): boolean => {
        if (this.tool === 'pan') return false;
        const k = this.w / this.logicalWidth;
        const x = lx * k, y = ly * k;
        if (this.tool === 'add' || this.tool === 'sub') {
            if (phase === 'down') this.click(x, y, (this.tool === 'add') !== ev.altKey ? 'add' : 'sub');
            return true;
        }
        const kind = this.tool as 'keep' | 'remove' | 'edge';
        if (phase === 'down') {
            this.stroke = { kind, points: [x, y], before: cloneMaps(this.maps), full: new Uint8ClampedArray(this.w * this.h), core: new Uint8ClampedArray(this.w * this.h) };
            this.extendStroke(0);
        } else if (this.stroke) {
            const s = this.stroke;
            const from = s.points.length;
            s.points.push(x, y);
            this.extendStroke(from);
            if (phase === 'up') {
                const op: Op = { kind: s.kind, radius: this.radius, points: s.points };
                this.ops.push(op);
                this.redoOps = [];
                this.stroke = null;
                this.version++;
                this.requestRefine();
                this.changed();
            }
        }
        return true;
    };

    private extendStroke(from: number) {
        const s = this.stroke!;
        stampStroke(s.full, this.w, this.h, s.points, this.radius, from);
        if (s.kind !== 'edge') stampStroke(s.core, this.w, this.h, s.points, this.radius - this.inset, from);
        this.maps = cloneMaps(s.before);
        applyStroke(this.maps, s.kind, s.full, s.core);
        this.version++;
        this.scheduleRender();
    }

    private async click(x: number, y: number, kind: 'add' | 'sub') {
        if (!this.selectReady) { this.onMessage('edit.selectLoading'); return; }
        this.clicks++;
        this.changed();
        try {
            const mask = await this.upscaler.editClick(this.nextOp++, Math.floor(x), Math.floor(y));
            const op: Op = { kind, mask };
            const parts = objectParts(mask, this.w, this.h, this.inset);
            this.parts.set(op, parts);
            this.ops.push(op);
            this.redoOps = [];
            applyObject(this.maps, kind, mask, parts);
            this.version++;
            this.render();
            this.requestRefine();
        } catch (e) {
            console.warn('click selection failed:', e);
            this.onMessage('edit.clickFailed');
        } finally {
            this.clicks--;
            this.changed();
        }
    }

    undo() {
        const op = this.ops.pop();
        if (!op) return;
        this.redoOps.push(op);
        this.recompose();
    }

    redo() {
        const op = this.redoOps.pop();
        if (!op) return;
        this.ops.push(op);
        this.recompose();
    }

    /** back to the automatic selection */
    reset() {
        if (!this.ops.length) return;
        this.ops = [];
        this.redoOps = [];
        this.recompose();
    }

    setGhost(on: boolean) { this.ghost = on; this.render(); }

    private recompose() {
        this.maps = compose(this.session.base, this.w, this.h, this.ops, this.inset, this.parts);
        this.version++;
        this.render();
        this.requestRefine();
        this.changed();
    }

    private requestRefine() {
        if (this.refining) { this.dirty = true; return; }
        this.refining = true;
        this.changed();
        const v = this.version;
        this.upscaler.editRefine(cloneMaps(this.maps)).then(rgba => {
            if (v === this.version) { this.preview = { version: v, rgba }; this.render(); }
        }, e => console.warn('preview failed:', e)).finally(() => {
            this.refining = false;
            if (this.dirty) { this.dirty = false; this.requestRefine(); }
            this.changed();
        });
    }

    private scheduleRender() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
    }

    /** refined preview if it matches the current selection, else the coarse selection with the painted interiors */
    private render() {
        const src = this.session.rgba, out = this.image.data, n = this.w * this.h;
        const p = this.preview && this.preview.version === this.version ? this.preview.rgba : null;
        const { coarse, keep, remove } = this.maps;
        const ghost = this.ghost ? 0.25 : 0;
        for (let i = 0, d = 0; i < n; i++, d += 4) {
            let a: number;
            if (p) {
                a = p[d + 3];
                out[d] = p[d]; out[d + 1] = p[d + 1]; out[d + 2] = p[d + 2];
            } else {
                a = coarse[i];
                if (keep[i] > a) a = keep[i];
                if (255 - remove[i] < a) a = 255 - remove[i];
                out[d] = src[d]; out[d + 1] = src[d + 1]; out[d + 2] = src[d + 2];
            }
            out[d + 3] = a + ghost * (255 - a);
        }
        this.ctx.putImageData(this.image, 0, 0);
    }

    destroy() {
        cancelAnimationFrame(this.frame);
        this.canvas.remove();
    }
}
