// Before/after view (docs/ui.md "Vergleich"): both pictures lie on top of each other at the output size; the result is
// clipped at a vertical divider that can be dragged. Mouse wheel zooms around the cursor, dragging elsewhere pans,
// double click switches between "fit" and "actual size" (1 output pixel = 1 screen pixel). From 300 % on the pixels are
// shown sharp (no smoothing) so the result can be judged pixel by pixel.
//
// Coordinates: the picture has a logical size (lw × lh = output pixels); `z` = screen px per output px, (tx, ty) = its
// top-left corner in stage px. The divider position is kept in picture coordinates (dx), so it stays on the same detail
// while zooming.

export interface Insets { left: number; top: number; right: number; bottom: number }

/** background behind transparent results (preview only – the file keeps its transparency) */
export type PreviewBackground = 'checker' | 'black' | 'white' | 'red' | 'green' | 'blue';
export const BACKGROUNDS: Record<PreviewBackground, string> = {
    checker: '', black: '#000000', white: '#ffffff', red: '#e11d1d', green: '#16a34a', blue: '#2563eb',
};

/** pointer events in edit mode, in picture coordinates (logical output pixels) */
export type EditPointer = (phase: 'down' | 'move' | 'up', x: number, y: number, ev: PointerEvent) => boolean | void;

const MIN_ZOOM = 0.02, MAX_ZOOM = 32;

export class CompareView {
    private stage: HTMLElement;
    private canvas: HTMLElement;
    private before: HTMLImageElement;
    private after: HTMLImageElement;
    /** preview background behind a transparent result – its own layer, faded in once the picture is drawn */
    private afterBg: HTMLElement;
    private bgShown = false;
    /** counts results: a late decode of an older one must not show the background */
    private afterToken = 0;
    private divider: HTMLElement;
    private lw = 0;
    private lh = 0;
    private z = 1;
    private tx = 0;
    private ty = 0;
    private dx = 0;
    private fitted = true;
    private hasAfter = false;
    /** free area of the stage (panels cover the rest) – set by the page */
    insets: () => Insets = () => ({ left: 0, top: 0, right: 0, bottom: 0 });
    /** called after zoom/pan with the current zoom (screen px per output px, incl. device pixel ratio) */
    onZoom: (zoom: number) => void = () => {};
    /** edit mode: the edit canvas lies over the picture, the left button draws/clicks (pan: space or middle button) */
    private editCanvas: HTMLCanvasElement | null = null;
    private onEdit: EditPointer | null = null;
    private spaceDown = false;
    private background: PreviewBackground = 'checker';
    /** pointer position over the stage for the brush outline (null = outside) */
    onHover: (x: number, y: number, inside: boolean) => void = () => {};

    constructor(stage: HTMLElement) {
        this.stage = stage;
        this.canvas = stage.querySelector('[data-canvas]')!;
        this.before = stage.querySelector('[data-before]')!;
        this.after = stage.querySelector('[data-after]')!;
        this.afterBg = stage.querySelector('[data-after-bg]')!;
        this.divider = stage.querySelector('[data-divider]')!;
        this.bind();
        new ResizeObserver(() => (this.fitted ? this.fit() : this.update())).observe(stage);
    }

    /** show a picture (before) at the given logical size; clears the result */
    setBefore(url: string, lw: number, lh: number) {
        this.before.src = url;
        this.after.removeAttribute('src');
        this.hasAfter = false;
        this.showBg(false);
        this.lw = lw;
        this.lh = lh;
        this.dx = lw / 2;
        this.canvas.hidden = false;
        this.fit();
    }

    /** change the logical size (other factor) – keeps the view fitted if it was */
    resize(lw: number, lh: number) {
        if (lw === this.lw && lh === this.lh) return;
        const k = lw / this.lw;
        this.dx *= k;
        this.z /= k;
        this.lw = lw;
        this.lh = lh;
        if (this.fitted) this.fit(); else this.update();
    }

    /** show the result over the picture; its size becomes the logical size. `transparent`: checkerboard behind it
     *  (otherwise the "before" picture would shine through the removed background) */
    setAfter(url: string, lw: number, lh: number, transparent = false) {
        this.resize(lw, lh);
        const token = ++this.afterToken;
        this.after.src = url;
        this.after.dataset.transparent = transparent ? '1' : '';
        this.hasAfter = true;
        this.update();
        if (!transparent) { this.showBg(false); return; }
        this.paintBackground(this.afterBg, true);
        if (this.bgShown) return;   // already behind the previous version (new grain, applied edit)
        // first the picture, then the background fades in – no flash of the bare colour before the picture is there
        this.after.decode().catch(() => {}).then(() => requestAnimationFrame(() => {
            if (token === this.afterToken && this.after.dataset.transparent) this.showBg(true);
        }));
    }

    private showBg(on: boolean) {
        if (!on) this.afterToken++;   // a pending fade-in of the previous result is dropped
        this.bgShown = on;
        this.afterBg.style.opacity = on ? '1' : '0';
    }

    /** background behind transparent results and the edit preview */
    setBackground(bg: PreviewBackground) {
        this.background = bg;
        this.paintBackground(this.afterBg, !!this.after.dataset.transparent);
        if (this.editCanvas) this.paintBackground(this.editCanvas, true);
    }

    private paintBackground(el: HTMLElement, on: boolean) {
        const checker = on && this.background === 'checker';
        el.classList.toggle('checker', checker);
        el.style.backgroundColor = on && !checker ? BACKGROUNDS[this.background] : '';
    }

    /** edit mode on (canvas at work size, stretched over the picture) or off (null) */
    setEdit(canvas: HTMLCanvasElement | null, onPointer: EditPointer | null) {
        this.editCanvas?.remove();
        this.editCanvas = canvas;
        this.onEdit = onPointer;
        if (canvas) {
            canvas.className = 'absolute inset-0 size-full';
            this.paintBackground(canvas, true);
            this.canvas.append(canvas);
        }
        this.update();
    }

    /** screen px per logical px (for the brush outline) */
    get zoom() { return this.z; }
    get logicalWidth() { return this.lw; }

    clearAfter() {
        this.after.removeAttribute('src');
        this.hasAfter = false;
        this.showBg(false);
        this.update();
    }

    clear() {
        this.before.removeAttribute('src');
        this.after.removeAttribute('src');
        this.hasAfter = false;
        this.showBg(false);
        this.canvas.hidden = true;
        this.lw = this.lh = 0;
        this.update();
    }

    /** whole picture in the free area */
    fit() {
        if (!this.lw) return;
        const { width, height } = this.stage.getBoundingClientRect();
        const ins = this.insets();
        const aw = Math.max(50, width - ins.left - ins.right), ah = Math.max(50, height - ins.top - ins.bottom);
        this.z = Math.min(aw / this.lw, ah / this.lh, MAX_ZOOM);
        this.tx = ins.left + (aw - this.lw * this.z) / 2;
        this.ty = ins.top + (ah - this.lh * this.z) / 2;
        this.fitted = true;
        this.update();
    }

    /** 1 output pixel = 1 device pixel, centred on the divider (or the middle) */
    actualSize() {
        if (!this.lw) return;
        const { width, height } = this.stage.getBoundingClientRect();
        this.zoomAt(1 / devicePixelRatio, this.tx + this.dx * this.z, height / 2 || width / 2);
    }

    toggleFit() {
        if (this.fitted) this.actualSize(); else this.fit();
    }

    private zoomAt(z: number, sx: number, sy: number) {
        z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
        const px = (sx - this.tx) / this.z, py = (sy - this.ty) / this.z;
        this.z = z;
        this.tx = sx - px * z;
        this.ty = sy - py * z;
        this.fitted = false;
        this.update();
    }

    private update() {
        const { canvas, z } = this;
        canvas.style.width = `${this.lw}px`;
        canvas.style.height = `${this.lh}px`;
        canvas.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${z})`;
        const sharp = z * devicePixelRatio >= 3;
        canvas.classList.toggle('[image-rendering:pixelated]', sharp);
        this.dx = Math.min(this.lw, Math.max(0, this.dx));
        this.after.style.clipPath = this.afterBg.style.clipPath = `inset(0 0 0 ${this.dx}px)`;
        this.afterBg.style.setProperty('--checker', `${12 / z}px`);   // checkerboard squares stay 12 screen px
        this.after.hidden = !this.hasAfter || !!this.editCanvas;   // an empty <img> would still draw a hairline
        this.afterBg.hidden = this.after.hidden;
        this.divider.hidden = !this.hasAfter || !!this.editCanvas;
        if (this.editCanvas) canvas.classList.toggle('[image-rendering:pixelated]', sharp);
        if (this.hasAfter) {
            const x = this.tx + this.dx * z;
            this.divider.style.transform = `translateX(${x}px)`;
            // handle and labels in the visible part of the picture (not behind the panel, not off screen)
            const { height } = this.stage.getBoundingClientRect();
            const ins = this.insets();
            const top = Math.max(this.ty, ins.top), bottom = Math.min(this.ty + this.lh * z, height - ins.bottom);
            this.divider.style.setProperty('--handle-y', `${bottom > top ? (top + bottom) / 2 : height / 2}px`);
            this.divider.style.setProperty('--label-y', `${Math.max(top, 0) + 12}px`);
        }
        this.onZoom(z * devicePixelRatio);
    }

    private bind() {
        const stage = this.stage;
        let mode: 'pan' | 'divide' | null = null;
        let lastX = 0, lastY = 0;
        const toPicture = (e: PointerEvent): [number, number] => {
            const r = stage.getBoundingClientRect();
            return [(e.clientX - r.left - this.tx) / this.z, (e.clientY - r.top - this.ty) / this.z];
        };
        let editing = false;
        window.addEventListener('keydown', e => { if (e.code === 'Space' && this.editCanvas && !(e.target instanceof HTMLInputElement)) { this.spaceDown = true; e.preventDefault(); } });
        window.addEventListener('keyup', e => { if (e.code === 'Space') this.spaceDown = false; });
        stage.addEventListener('pointerdown', e => {
            if (!this.lw) return;
            // edit mode: left button = tool (unless space is held), middle button = pan
            if (this.editCanvas && this.onEdit && e.button === 0 && !this.spaceDown) {
                const [x, y] = toPicture(e);
                if (this.onEdit('down', x, y, e) !== false) {
                    editing = true;
                    stage.setPointerCapture(e.pointerId);
                    e.preventDefault();
                    return;
                }
            }
            if (e.button !== 0 && !(this.editCanvas && e.button === 1)) return;
            const handle = (e.target as HTMLElement).closest('[data-divider]');
            const nearLine = this.hasAfter && Math.abs(e.clientX - stage.getBoundingClientRect().left - (this.tx + this.dx * this.z)) < 8;
            mode = !this.editCanvas && (handle || nearLine) ? 'divide' : 'pan';
            lastX = e.clientX;
            lastY = e.clientY;
            stage.setPointerCapture(e.pointerId);
            stage.classList.add(mode === 'pan' ? 'cursor-grabbing' : 'cursor-ew-resize');
            e.preventDefault();
        });
        stage.addEventListener('pointermove', e => {
            const [px, py] = toPicture(e);
            this.onHover(e.clientX - stage.getBoundingClientRect().left, e.clientY - stage.getBoundingClientRect().top, true);
            if (editing) { this.onEdit?.('move', px, py, e); return; }
            if (!mode) return;
            if (mode === 'divide') {
                this.dx = (e.clientX - stage.getBoundingClientRect().left - this.tx) / this.z;
            } else {
                this.tx += e.clientX - lastX;
                this.ty += e.clientY - lastY;
                this.fitted = false;
            }
            lastX = e.clientX;
            lastY = e.clientY;
            this.update();
        });
        stage.addEventListener('pointerleave', () => this.onHover(0, 0, false));
        const end = (e: PointerEvent) => {
            if (editing) {
                editing = false;
                const [x, y] = toPicture(e);
                this.onEdit?.('up', x, y, e);
                return;
            }
            mode = null;
            stage.classList.remove('cursor-grabbing', 'cursor-ew-resize');
        };
        stage.addEventListener('pointerup', end);
        stage.addEventListener('pointercancel', end);
        stage.addEventListener('wheel', e => {
            if (!this.lw) return;
            e.preventDefault();
            const r = stage.getBoundingClientRect();
            const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;   // lines → pixels
            this.zoomAt(this.z * Math.exp(-delta * 0.0015), e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        stage.addEventListener('dblclick', e => {
            if ((e.target as HTMLElement).closest('[data-divider]') || this.editCanvas) return;
            this.toggleFit();
        });
        // keyboard on the focused divider: arrows move it (accessibility)
        this.divider.addEventListener('keydown', e => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const step = (e.shiftKey ? 0.1 : 0.02) * this.lw;
            this.dx += e.key === 'ArrowLeft' ? -step : step;
            this.update();
        });
    }
}
