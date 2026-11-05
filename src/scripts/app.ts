// The page (docs/ui.md): open an image (drop, file dialog, paste), choose content/quality/factor and whether to remove
// the background, process in the worker with progress, compare before/after, download as "<name>-upscale.<ext>"
// ("-cutout" at 1×) in the original format (PNG when the original cannot hold transparency).
import { applyDom, getLocale, t } from './i18n';
import { CompareView, type Insets } from './compare';
import { loadManifest, publicUrl, Upscaler, UpscaleError, type BackendInfo, type UpscaleResult } from './upscaler';
import { cachedModels } from './model-cache';
import { ALPHA_FORMATS, detectMime, FORMATS, resultName } from './image-io';
import { showNotice } from './notice';
import { buildAbout } from './about';
import { segmented } from './ui-controls';
import { CONTENT, CUTOUT, ENCODE, LIMITS, TILING } from './config';
import { debugLog, DEBUG } from './log';
import type { Manifest, ManifestModel, Progress } from './types';

type Content = 'photo' | 'drawing';
type Quality = 'fast' | 'quality';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const NBSP = ' ';

// --- state ---

const SETTINGS_KEY = 'upscalr.settings';
type Factor = 1 | 2 | 4;
const settings: { content: Content; quality: Quality; factor: Factor; cutout: boolean } = { content: 'photo', quality: 'fast', factor: 4, cutout: false };
try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (saved.content === 'photo' || saved.content === 'drawing') settings.content = saved.content;
    if (saved.quality === 'fast' || saved.quality === 'quality') settings.quality = saved.quality;
    if (saved.factor === 1 || saved.factor === 2 || saved.factor === 4) settings.factor = saved.factor;
    if (typeof saved.cutout === 'boolean') settings.cutout = saved.cutout;
} catch { /* storage blocked or broken */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

interface Source { file: File; name: string; mime: string; url: string; width: number; height: number }
interface Result extends UpscaleResult { url: string; name: string; key: string }

let source: Source | null = null;
let result: Result | null = null;
let running: { cancel: () => void } | null = null;
let manifest: Manifest | null = null;
let cached = new Set<string>();

const upscaler = new Upscaler();
const compare = new CompareView($('#stage'));

// --- formatting ---

const num = (n: number) => n.toLocaleString(getLocale());
const megabytes = (bytes: number) => bytes < 1048576
    ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(getLocale())}${NBSP}KB`
    : `${(bytes / 1048576).toLocaleString(getLocale(), { maximumFractionDigits: bytes < 10485760 ? 1 : 0 })}${NBSP}MB`;
const duration = (ms: number) => {
    const s = ms / 1000;
    if (s < 60) return `${s.toLocaleString(getLocale(), { maximumFractionDigits: s < 10 ? 1 : 0 })}${NBSP}s`;
    return `${Math.floor(s / 60)}${NBSP}min ${Math.round(s % 60)}${NBSP}s`;
};
const dims = (w: number, h: number) => `${num(w)}${NBSP}×${NBSP}${num(h)}`;

// --- model choice ---

const modelId = () => (settings.content === 'drawing' ? CONTENT.drawing : CONTENT.photo[settings.quality]);
const settingsKey = () => `${settings.factor > 1 ? modelId() : '-'}|${settings.factor}|${settings.cutout}`;
/** the file of a model for the current backend (half floats where the GPU can) */
function fileOf(m: ManifestModel | undefined) {
    if (!m || !upscaler.info) return null;
    const v = m.variants[upscaler.info.precision] ?? m.variants.fp32;
    return { url: publicUrl(`models/${v.file}`), bytes: v.bytes };
}
/** models the current settings need: upscaling (not at 1×) and/or background removal */
function neededModels() {
    const upModel = manifest?.models[modelId()], cutModel = manifest?.models[CUTOUT];
    const up = settings.factor > 1 ? fileOf(upModel) : null;
    const cut = settings.cutout ? fileOf(cutModel) : null;
    return {
        upscale: up && upModel?.scale ? { ...up, scale: upModel.scale } : null,
        cutout: cut && cutModel?.input ? { ...cut, ...cutModel.input } : null,
        missing: (settings.factor > 1 && !up) || (settings.cutout && !cut),
    };
}
const allModelUrls = () => Object.values(manifest?.models ?? {}).flatMap(m => Object.values(m.variants).map(v => publicUrl(`models/${v.file}`)));

/** output fits into a canvas of this browser (config LIMITS) */
const fits = (w: number, h: number, f: number) => w * f <= LIMITS.maxSide && h * f <= LIMITS.maxSide && w * h * f * f <= LIMITS.maxPixels;

// --- panel ---

const panel = $('#panel');
const runButton = $<HTMLButtonElement>('[data-run]', panel);
const cancelButton = $<HTMLButtonElement>('[data-cancel]', panel);
const download = $<HTMLAnchorElement>('[data-download]', panel);
const progressBox = $('[data-progress]', panel);

const setContent = segmented($('[data-seg="content"]', panel), v => { settings.content = v as Content; changed(); });
const setQuality = segmented($('[data-seg="quality"]', panel), v => { settings.quality = v as Quality; changed(); });
const setFactor = segmented($('[data-seg="factor"]', panel), v => { settings.factor = Number(v) as Factor; changed(); });
const setBackground = segmented($('[data-seg="background"]', panel), v => { settings.cutout = v === 'remove'; changed(); });
setContent(settings.content);
setQuality(settings.quality);
setFactor(String(settings.factor));
setBackground(settings.cutout ? 'remove' : 'keep');

function changed() {
    saveSettings();
    if (source && !result) compare.resize(source.width * settings.factor, source.height * settings.factor);
    updatePanel();
}

function updatePanel() {
    $('[data-quality-row]', panel).hidden = settings.content !== 'photo';
    // at 1× there is no upscaling: content and quality do not matter
    $('[data-upscale-rows]', panel).classList.toggle('opacity-40', settings.factor === 1);
    const fileBox = $('[data-file]', panel);
    $('[data-file-name]', fileBox).textContent = source ? source.name : t('panel.noImage');
    $('[data-file-name]', fileBox).title = source?.name ?? '';
    $('[data-file-size]', fileBox).textContent = source ? `${dims(source.width, source.height)}${NBSP}px · ${FORMATS[source.mime]?.label ?? source.mime}` : '';

    const sizeLine = $('[data-size]', panel);
    const tooLarge = !!source && !fits(source.width, source.height, settings.factor);
    sizeLine.textContent = source ? t('panel.size', { from: dims(source.width, source.height), to: dims(source.width * settings.factor, source.height * settings.factor) }) : '';
    const warn = $('[data-too-large]', panel);
    warn.hidden = !tooLarge;
    if (tooLarge) warn.textContent = t('panel.tooLarge', { factor: settings.factor, max: num(LIMITS.maxSide), mp: num(Math.round(LIMITS.maxPixels / 1e6)) });

    const need = neededModels();
    const files = [need.upscale, need.cutout].filter(f => f !== null);
    const toLoad = files.filter(f => !cached.has(f.url)).reduce((n, f) => n + f.bytes, 0);
    $('[data-model]', panel).textContent = !manifest || !files.length ? '' : toLoad ? t('panel.modelSize', { size: megabytes(toLoad) }) : t('panel.modelCached');
    const nothingToDo = settings.factor === 1 && !settings.cutout;
    const hint = $('[data-hint]', panel);
    hint.hidden = !nothingToDo;
    hint.textContent = nothingToDo ? t('panel.needCutout') : '';

    const outdated = !!result && result.key !== settingsKey();
    runButton.disabled = !source || !manifest || !upscaler.info || tooLarge || nothingToDo || need.missing || !!running || (!!result && !outdated);
    $('[data-run-label]', runButton).textContent = t(settings.factor === 1 ? (result ? 'panel.againCutout' : 'panel.startCutout') : result ? 'panel.again' : 'panel.start');
    runButton.hidden = !!running;
    cancelButton.hidden = !running;

    download.hidden = !result;
    if (result) {
        download.href = result.url;
        download.download = result.name;
        $('[data-download-name]', panel).textContent = result.name;
        $('[data-result-info]', panel).textContent = `${dims(result.width, result.height)}${NBSP}px · ${megabytes(result.blob.size)} · ${t('panel.doneIn', { time: duration(result.ms) })}${outdated ? ` · ${t('panel.outdated')}` : ''}`;
    }
    $('[data-download-box]', panel).hidden = !result;

    const info = upscaler.info;
    $('[data-backend]', panel).textContent = info ? `${t(`panel.backend.${info.backend}`)} · ${t(`panel.precision.${info.precision}`)}` : t('panel.backend.pending');
}

// --- progress ---

let tilesStarted = 0;
function showProgress(p: Progress | null) {
    progressBox.hidden = !p;
    if (!p) return;
    const label = $('[data-label]', progressBox), bar = $('[data-bar]', progressBox), detail = $('[data-detail]', progressBox);
    let fraction = 0, text = '', extra = '';
    if (p.phase === 'download') {
        fraction = p.total ? p.loaded / p.total : 0;
        text = t('progress.download', { loaded: megabytes(p.loaded), total: p.total ? megabytes(p.total) : '?' });
    } else if (p.phase === 'prepare') {
        text = t('progress.prepare');
    } else if (p.phase === 'cutout') {
        text = t('progress.cutout');
    } else if (p.phase === 'refine') {
        fraction = 1;
        text = t('progress.refine');
    } else if (p.phase === 'tiles') {
        if (p.done === 0) tilesStarted = performance.now();
        fraction = p.done / p.total;
        text = t('progress.tiles', { done: p.done, total: p.total });
        if (p.done > 0 && p.done < p.total) {
            const eta = ((performance.now() - tilesStarted) / p.done) * (p.total - p.done);
            extra = t('progress.eta', { time: duration(eta) });
        }
    } else if (p.phase === 'alpha') {
        fraction = 1;
        text = t('progress.alpha');
    } else if (p.phase === 'encode') {
        fraction = 1;
        text = t('progress.encode');
    }
    label.textContent = text;
    detail.textContent = extra;
    bar.style.width = `${Math.round(fraction * 100)}%`;
}

// --- open an image ---

async function openFile(file: File) {
    if (running) return;
    const mime = await detectMime(file);
    if (!mime.startsWith('image/')) {
        showNotice({ id: 'open', icon: 'warning', title: t('notice.notImage.title'), message: t('notice.notImage.message', { name: file.name }), timeout: 8000 });
        return;
    }
    let width = 0, height = 0;
    try {
        const bitmap = await createImageBitmap(file);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
    } catch {
        showNotice({ id: 'open', icon: 'warning', title: t('notice.decode.title'), message: t('notice.decode.message', { name: file.name }), timeout: 10000 });
        return;
    }
    if (source) URL.revokeObjectURL(source.url);
    clearResult();
    source = { file, name: file.name || `image.${FORMATS[mime]?.ext ?? 'png'}`, mime, url: URL.createObjectURL(file), width, height };
    debugLog('open', source.name, mime, width, height);
    document.body.classList.add('has-image');
    $('#start').hidden = true;
    $('#view-tools').hidden = false;
    compare.setBefore(source.url, width * settings.factor, height * settings.factor);
    updatePanel();
}

function clearResult() {
    if (result) URL.revokeObjectURL(result.url);
    result = null;
    compare.clearAfter();
}

// --- upscale ---

async function upscale() {
    if (!source || running) return;
    const need = neededModels();
    if (need.missing || (!need.upscale && !need.cutout)) return;
    const key = settingsKey();
    const suffix = settings.factor === 1 ? 'cutout' : 'upscale';   // settings may change while it runs
    const src = source;
    // transparency needs a format that can hold it (JPEG cannot) → PNG
    const mime = need.cutout && !ALPHA_FORMATS.has(src.mime) ? 'image/png' : src.mime;
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(src.file);
    } catch {
        showNotice({ id: 'open', icon: 'warning', title: t('notice.decode.title'), message: t('notice.decode.message', { name: src.name }) });
        return;
    }
    const job = upscaler.run({
        bitmap,
        factor: settings.factor,
        upscale: need.upscale,
        cutout: need.cutout,
        mime,
        tile: { ...TILING },
        quality: { ...ENCODE },
        keepUrls: allModelUrls(),
    }, showProgress, size => {
        showNotice({ id: 'tile', icon: 'info', title: t('notice.tileReduced.title'), message: t('notice.tileReduced.message', { size }), timeout: 8000 });
    });
    running = job;
    showProgress({ phase: 'prepare' });
    updatePanel();
    try {
        const r = await job.promise;
        if (source !== src) return;   // another image was opened meanwhile (not possible while running – safety)
        clearResult();
        const name = resultName(src.name, src.mime, r.mime, suffix);
        result = { ...r, url: URL.createObjectURL(r.blob), name, key };
        compare.setAfter(result.url, r.width, r.height, r.alpha);
        if (mime !== src.mime) {
            showNotice({ id: 'format', icon: 'info', title: t('notice.alphaFormat.title', { format: FORMATS[r.mime]?.label ?? r.mime }),
                message: t('notice.alphaFormat.message', { format: FORMATS[src.mime]?.label ?? src.mime, target: FORMATS[r.mime]?.label ?? r.mime }), timeout: 12000 });
        } else if (r.mime !== src.mime) {
            showNotice({ id: 'format', icon: 'info', title: t('notice.formatFallback.title', { format: FORMATS[r.mime]?.label ?? r.mime }),
                message: t('notice.formatFallback.message', { format: FORMATS[src.mime]?.label ?? src.mime, target: FORMATS[r.mime]?.label ?? r.mime }), timeout: 12000 });
        }
        debugLog('done', r.width, r.height, r.mime, `${Math.round(r.ms)} ms`, `${r.blob.size} bytes`);
    } catch (e) {
        const err = e instanceof UpscaleError ? e : new UpscaleError('unknown', String(e));
        if (err.code !== 'cancelled') {
            showNotice({ id: 'error', icon: 'warning', title: t('notice.error.title'), message: `${t(`notice.error.${err.code}`)}${DEBUG ? `\n${err.message}` : ''}` });
        }
    } finally {
        running = null;
        showProgress(null);
        cached = await cachedModels();
        updatePanel();
    }
}

runButton.addEventListener('click', upscale);
cancelButton.addEventListener('click', () => running?.cancel());

// --- file input, drop, paste ---

const fileInput = $<HTMLInputElement>('#file-input');
for (const b of document.querySelectorAll<HTMLElement>('[data-pick]')) b.addEventListener('click', () => !running && fileInput.click());
fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) openFile(f);
});

const overlay = $('#drop-overlay');
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = !!running; });
window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = running ? 'none' : 'copy'; });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const f = [...(e.dataTransfer?.files ?? [])][0];
    if (f) openFile(f);
});
window.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); openFile(f); }
});

// --- view tools, keys ---

const zoomLabel = $('[data-zoom]');
compare.onZoom = z => { zoomLabel.textContent = `${Math.round(z * 100)}${NBSP}%`; };
$('[data-fit]').addEventListener('click', () => compare.fit());
$('[data-actual]').addEventListener('click', () => compare.actualSize());
window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && running) running.cancel();
    else if (e.key === '0' && source) compare.fit();
    else if (e.key === '1' && source) compare.actualSize();
});

// free area for "fit": next to the panel (wide window) or above it (narrow window, panel at the bottom)
compare.insets = (): Insets => {
    const stage = $('#stage').getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const gap = 20;
    if (p.width < stage.width * 0.6) return { left: p.right + gap, top: gap, right: gap, bottom: 48 };
    return { left: gap, top: gap, right: gap, bottom: stage.bottom - p.top + gap };
};

// --- about ---

const aboutDialog = $<HTMLDialogElement>('#about');
function compute() {
    const info = upscaler.info;
    if (!info) return '';
    return [t(`panel.backend.${info.backend}`), t(`panel.precision.${info.precision}`), info.adapter].filter(Boolean).join(' · ');
}
for (const b of document.querySelectorAll('[data-about], [data-about-mobile]')) b.addEventListener('click', () => {
    $('[data-about-body]', aboutDialog).replaceChildren(buildAbout({ compute: compute() }));
    aboutDialog.showModal();
});
$('[data-about-close]', aboutDialog).addEventListener('click', () => aboutDialog.close());
aboutDialog.addEventListener('click', e => { if (e.target === aboutDialog) aboutDialog.close(); });
document.addEventListener('upscalr:language', () => {
    applyDom();
    updatePanel();
    $('[data-about-body]', aboutDialog).replaceChildren(buildAbout({ compute: compute() }));
});

// --- start ---

applyDom();
updatePanel();
upscaler.onBackend = (info: BackendInfo) => {
    debugLog('backend', info);
    if (info.backend === 'wasm') {
        showNotice({ id: 'backend', icon: 'info', title: t('notice.noWebgpu.title'), message: t('notice.noWebgpu.message'), timeout: 15000 });
    }
    updatePanel();
};
manifest = await loadManifest();
if (!manifest) showNotice({ id: 'models', icon: 'warning', title: t('notice.noModels.title'), message: t('notice.noModels.message') });
cached = await cachedModels();
await upscaler.ready;
updatePanel();
document.body.classList.add('ready');
if (DEBUG) Object.assign(globalThis, { __upscalr: { openFile, upscale, compare, upscaler, get result() { return result; } } });
