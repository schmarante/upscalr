// Before/after view (docs/ui.md "Vergleich"): both pictures lie on top of each other at the output size; the result is
// clipped at a vertical divider that can be dragged. Mouse wheel zooms around the cursor, dragging elsewhere pans,
// double click switches between "fit" and "actual size" (1 output pixel = 1 screen pixel). From 300 % on the pixels are
// shown sharp (no smoothing) so the result can be judged pixel by pixel.
//
// Coordinates: the picture has a logical size (lw × lh = output pixels); `z` = screen px per output px, (tx, ty) = its
// top-left corner in stage px. The divider position is kept in picture coordinates (dx), so it stays on the same detail
// while zooming.

export interface Insets { left: number; top: number; right: number; bottom: number }

const MIN_ZOOM = 0.02, MAX_ZOOM = 32;

export class CompareView {
    private stage: HTMLElement;
    private canvas: HTMLElement;
    private before: HTMLImageElement;
    private after: HTMLImageElement;
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

    constructor(stage: HTMLElement) {
        this.stage = stage;
        this.canvas = stage.querySelector('[data-canvas]')!;
        this.before = stage.querySelector('[data-before]')!;
        this.after = stage.querySelector('[data-after]')!;
        this.divider = stage.querySelector('[data-divider]')!;
        this.bind();
        new ResizeObserver(() => (this.fitted ? this.fit() : this.update())).observe(stage);
    }

    /** show a picture (before) at the given logical size; clears the result */
    setBefore(url: string, lw: number, lh: number) {
        this.before.src = url;
        this.after.removeAttribute('src');
        this.hasAfter = false;
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
        this.after.src = url;
        this.after.classList.toggle('checker', transparent);
        this.hasAfter = true;
        this.update();
    }

    clearAfter() {
        this.after.removeAttribute('src');
        this.hasAfter = false;
        this.update();
    }

    clear() {
        this.before.removeAttribute('src');
        this.after.removeAttribute('src');
        this.hasAfter = false;
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
        this.after.style.clipPath = `inset(0 0 0 ${this.dx}px)`;
        this.after.style.setProperty('--checker', `${12 / z}px`);   // checkerboard squares stay 12 screen px
        this.after.hidden = !this.hasAfter;   // an empty <img> would still draw a hairline
        this.divider.hidden = !this.hasAfter;
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
        stage.addEventListener('pointerdown', e => {
            if (e.button !== 0 || !this.lw) return;
            const handle = (e.target as HTMLElement).closest('[data-divider]');
            const nearLine = this.hasAfter && Math.abs(e.clientX - stage.getBoundingClientRect().left - (this.tx + this.dx * this.z)) < 8;
            mode = handle || nearLine ? 'divide' : 'pan';
            lastX = e.clientX;
            lastY = e.clientY;
            stage.setPointerCapture(e.pointerId);
            stage.classList.add(mode === 'pan' ? 'cursor-grabbing' : 'cursor-ew-resize');
            e.preventDefault();
        });
        stage.addEventListener('pointermove', e => {
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
        const end = () => {
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
            if ((e.target as HTMLElement).closest('[data-divider]')) return;
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
