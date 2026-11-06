// The page (docs/ui.md): open an image (drop, file dialog, paste), choose content/quality/factor and whether to remove
// the background, process in the worker with progress, compare before/after, download as "<name>-upscale.<ext>"
// ("-cutout" / "-sharpen" at 1×) in the original format (PNG when the original cannot hold transparency).
// On opening, the worker measures how sharp the picture really is; a soft photo can be sharpened first (deblurring model
// and shrinking to its real resolution – the model is only downloaded after the user agreed).
import { applyDom, getLocale, t } from './i18n';
import { BACKGROUNDS, CompareView, type Insets, type PreviewBackground } from './compare';
import { loadManifest, publicUrl, Upscaler, UpscaleError, type BackendInfo, type UpscaleResult, type WorkerNotice } from './upscaler';
import { BRUSHES, SelectionEditor, type EditHistory, type Tool } from './editor';
import { cachedModels } from './model-cache';
import { ALPHA_FORMATS, detectMime, FORMATS, resultName } from './image-io';
import { showNotice } from './notice';
import { buildAbout } from './about';
import { segmented } from './ui-controls';
import { CONTENT, CUTOUT, EDIT, ENCODE, GRAIN, LIMITS, SHARPEN, TILING } from './config';
import { debugLog, DEBUG } from './log';
import type { Manifest, ManifestModel, Progress, SharpenMode, Sharpness } from './types';

type Content = 'photo' | 'drawing';
type Quality = 'fast' | 'quality';
type Smoothing = keyof typeof CONTENT.photo.fast;
type Sharpen = 'off' | SharpenMode;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const NBSP = ' ';

// --- state ---

const SETTINGS_KEY = 'upscalr.settings';
type Factor = 1 | 2 | 4;
/**
 * sharpen: what to do with soft photos; sharpenConsent: the user agreed to download the deblurring model;
 * sharpenAsked: the suggestion on a soft photo was answered (not shown again)
 */
const settings: { content: Content; quality: Quality; smoothing: Smoothing; grain: number; factor: Factor; cutout: boolean; sharpen: Sharpen; sharpenConsent: boolean; sharpenAsked: boolean } =
    { content: 'photo', quality: 'fast', smoothing: 'medium', grain: 0, factor: 4, cutout: false, sharpen: 'off', sharpenConsent: false, sharpenAsked: false };
try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (saved.content === 'photo' || saved.content === 'drawing') settings.content = saved.content;
    if (saved.quality === 'fast' || saved.quality === 'quality') settings.quality = saved.quality;
    if (Object.hasOwn(CONTENT.photo.fast, saved.smoothing)) settings.smoothing = saved.smoothing;
    if (Number.isFinite(saved.grain)) settings.grain = Math.max(0, Math.min(GRAIN.max, Math.round(saved.grain)));
    if (saved.factor === 1 || saved.factor === 2 || saved.factor === 4) settings.factor = saved.factor;
    if (typeof saved.cutout === 'boolean') settings.cutout = saved.cutout;
    if (saved.sharpen === 'off' || saved.sharpen === 'fast' || saved.sharpen === 'thorough') settings.sharpen = saved.sharpen;
    if (typeof saved.sharpenConsent === 'boolean') settings.sharpenConsent = saved.sharpenConsent;
    if (typeof saved.sharpenAsked === 'boolean') settings.sharpenAsked = saved.sharpenAsked;
} catch { /* storage blocked or broken */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

/** sharpness: measured on opening (null while the worker measures) */
interface Source { file: File; name: string; mime: string; url: string; width: number; height: number; sharpness: Sharpness | null }
/** key: settings it was made with (another key = outdated); grain: the grain in it (0…1) */
interface Result extends UpscaleResult { url: string; name: string; key: string; grain: number }

let source: Source | null = null;
let result: Result | null = null;
let running: { cancel: () => void } | null = null;
/** the worker still holds the last result (cleared when a new run starts) – needed for editing and a new grain */
let workerHasResult = false;
/** writing the result again with another grain */
let regraining = false;
/** the applied edit of the current result – editing again continues from it (dropped with a new result) */
let editHistory: EditHistory | null = null;
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

const modelId = () => (settings.content === 'drawing' ? CONTENT.drawing
    : settings.quality === 'fast' ? CONTENT.photo.fast[settings.smoothing] : CONTENT.photo.quality);
/**
 * Sharpening for the current picture: the chosen mode when the photo was measured soft. Shrunk to half before
 * upscaling (its real resolution) – except at 4×: the upscaler only reaches 4× of the shrunk picture, so it is only
 * deblurred there (docs/inference.md "Weiche Fotos").
 */
function sharpenPlan(): { mode: SharpenMode; shrink: 1 | 2 } | null {
    if (settings.content !== 'photo' || settings.sharpen === 'off' || !source?.sharpness?.soft) return null;
    return { mode: settings.sharpen, shrink: settings.factor === 4 ? 1 : 2 };
}
/** the upscaler runs: above 1×, and at 1× for a shrunk soft photo (back to its size) */
const upscaling = () => settings.factor > 1 || (sharpenPlan()?.shrink ?? 1) > 1;
/** grain of the current settings (0…1): photos, when upscaled */
const grainAmount = () => (settings.content === 'photo' && upscaling() ? settings.grain / 100 : 0);
/** the settings a result was made with (cut-out last: editing checks it) */
const settingsKey = () => `${upscaling() ? modelId() : '-'}|${settings.factor}|${sharpenPlan()?.mode ?? '-'}|${settings.cutout}`;
/** the file of a model for the current backend (half floats where the GPU can; a large model has only those) */
function fileOf(m: ManifestModel | undefined) {
    if (!m || !upscaler.info) return null;
    const v = m.variants[upscaler.info.precision] ?? m.variants.fp32 ?? m.variants.fp16;
    return v ? { url: publicUrl(`models/${v.file}`), bytes: v.bytes } : null;
}
/** the deblurring model's file for this backend (size for the consent question) */
const sharpenFile = () => fileOf(manifest?.models[SHARPEN.model]);
/** models the current settings need: upscaling, background removal, deblurring (soft photo) */
function neededModels() {
    const upModel = manifest?.models[modelId()], cutModel = manifest?.models[CUTOUT];
    const plan = sharpenPlan();
    const up = upscaling() ? fileOf(upModel) : null;
    const cut = settings.cutout ? fileOf(cutModel) : null;
    const sharp = plan ? sharpenFile() : null;
    return {
        upscale: up && upModel?.scale ? { ...up, scale: upModel.scale } : null,
        cutout: cut && cutModel?.input ? { ...cut, ...cutModel.input } : null,
        sharpen: sharp && plan ? { ...sharp, ...plan } : null,
        missing: (upscaling() && !up) || (settings.cutout && !cut) || (!!plan && !sharp),
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
const setSmoothing = segmented($('[data-seg="smoothing"]', panel), v => { settings.smoothing = v as Smoothing; changed(); });
const grainInput = $<HTMLInputElement>('[data-grain]', panel);
const grainValue = $('[data-grain-value]', panel);
const showGrain = () => { grainValue.textContent = settings.grain ? `${settings.grain}${NBSP}%` : t('panel.grainOff'); };
// moving shows the value, letting go applies it (a new grain only writes the result again)
grainInput.addEventListener('input', () => { settings.grain = Number(grainInput.value); showGrain(); });
grainInput.addEventListener('change', () => { settings.grain = Number(grainInput.value); changed(); });
const setFactor = segmented($('[data-seg="factor"]', panel), v => { settings.factor = Number(v) as Factor; changed(); });
const setCutoutMode = segmented($('[data-seg="background"]', panel), v => { settings.cutout = v === 'remove'; changed(); });
const setSharpen = segmented($('[data-seg="sharpen"]', panel), v => chooseSharpen(v as Sharpen));
setContent(settings.content);
setQuality(settings.quality);
setSmoothing(settings.smoothing);
grainInput.value = String(settings.grain);
setFactor(String(settings.factor));
setCutoutMode(settings.cutout ? 'remove' : 'keep');
setSharpen(settings.sharpen);

/** a sharpening mode – the model download needs the user's consent first (unless it is already in the browser) */
function chooseSharpen(mode: Sharpen) {
    const file = sharpenFile();
    if (mode === 'off' || settings.sharpenConsent || !file || cached.has(file.url)) {
        settings.sharpen = mode;
        changed();
        return;
    }
    setSharpen(settings.sharpen);   // back until agreed
    showNotice({
        id: 'sharpen', icon: 'info', title: t('notice.sharpenConsent.title'),
        message: t('notice.sharpenConsent.message', { size: megabytes(file.bytes) }),
        actions: [
            { label: t('notice.sharpenConsent.load'), primary: true, onClick: () => enableSharpen(mode) },
            { label: t('notice.sharpenConsent.cancel') },
        ],
    });
}

function enableSharpen(mode: SharpenMode) {
    settings.sharpen = mode;
    settings.sharpenConsent = true;
    settings.sharpenAsked = true;
    setSharpen(mode);
    changed();
}

/** a soft photo, sharpening off and never asked: suggest it (with the download size – the answer is the consent) */
function suggestSharpen() {
    const file = sharpenFile();
    if (!source?.sharpness?.soft || settings.content !== 'photo' || settings.sharpen !== 'off' || settings.sharpenAsked || !file) return;
    const download = settings.sharpenConsent || cached.has(file.url) ? '' : ` ${t('notice.soft.download', { size: megabytes(file.bytes) })}`;
    showNotice({
        id: 'sharpen', icon: 'info', title: t('notice.soft.title'), message: t('notice.soft.message') + download,
        actions: [
            { label: t('notice.soft.fast'), primary: true, onClick: () => enableSharpen('fast') },
            { label: t('notice.soft.thorough'), onClick: () => enableSharpen('thorough') },
            { label: t('notice.soft.no'), onClick: () => { settings.sharpenAsked = true; saveSettings(); } },
        ],
    });
}

function changed() {
    saveSettings();
    if (source && !result) compare.resize(source.width * settings.factor, source.height * settings.factor);
    updatePanel();
    regrain();   // back to the settings of the result, but with another grain
}

function updatePanel() {
    $('[data-quality-row]', panel).hidden = settings.content !== 'photo';
    $('[data-smoothing-row]', panel).hidden = settings.content !== 'photo' || settings.quality !== 'fast';
    $('[data-grain-row]', panel).hidden = settings.content !== 'photo';
    $('[data-sharpen-row]', panel).hidden = settings.content !== 'photo';
    grainInput.disabled = !!running || !!editor;
    showGrain();
    // name of the current choice next to the row name (the options are icons only)
    for (const el of panel.querySelectorAll<HTMLElement>('[data-current]')) {
        const on = panel.querySelector<HTMLElement>(`[data-seg="${el.dataset.current}"] [aria-pressed="true"]`);
        el.textContent = on?.dataset.i18nAria ? t(on.dataset.i18nAria) : '';
    }
    // at 1× there is no upscaling: content and quality do not matter
    $('[data-upscale-rows]', panel).classList.toggle('opacity-40', !upscaling());
    const fileBox = $('[data-file]', panel);
    $('[data-file-name]', fileBox).textContent = source ? source.name : t('panel.noImage');
    $('[data-file-name]', fileBox).title = source?.name ?? '';
    $('[data-file-size]', fileBox).textContent = source ? `${dims(source.width, source.height)}${NBSP}px · ${FORMATS[source.mime]?.label ?? source.mime}${source.sharpness?.soft ? ` · ${t('panel.soft')}` : ''}` : '';

    const sizeLine = $('[data-size]', panel);
    const tooLarge = !!source && !fits(source.width, source.height, settings.factor);
    sizeLine.textContent = source ? t('panel.size', { from: dims(source.width, source.height), to: dims(source.width * settings.factor, source.height * settings.factor) }) : '';
    const warn = $('[data-too-large]', panel);
    warn.hidden = !tooLarge;
    if (tooLarge) warn.textContent = t('panel.tooLarge', { factor: settings.factor, max: num(LIMITS.maxSide), mp: num(Math.round(LIMITS.maxPixels / 1e6)) });

    // sharpening chosen: say whether this photo gets it
    const sharpenInfo = $('[data-sharpen-info]', panel);
    const sharpenState = !source || settings.content !== 'photo' || settings.sharpen === 'off' ? ''
        : !source.sharpness ? t('panel.sharpenChecking') : source.sharpness.soft ? t('panel.sharpenSoft') : t('panel.sharpenSharp');
    sharpenInfo.hidden = !sharpenState;
    sharpenInfo.textContent = sharpenState;

    const need = neededModels();
    const files = [need.upscale, need.cutout, need.sharpen].filter(f => f !== null);
    const toLoad = files.filter(f => !cached.has(f.url)).reduce((n, f) => n + f.bytes, 0);
    $('[data-model]', panel).textContent = !manifest || !files.length ? '' : toLoad ? t('panel.modelSize', { size: megabytes(toLoad) }) : t('panel.modelCached');
    const nothingToDo = !upscaling() && !settings.cutout;
    // the measurement is still running and would decide about sharpening
    const measuring = !!source && !source.sharpness && settings.content === 'photo' && settings.sharpen !== 'off';
    const hint = $('[data-hint]', panel);
    hint.hidden = !nothingToDo;
    hint.textContent = nothingToDo ? t('panel.needCutout') : '';

    // another grain is applied to the result directly – only if the worker no longer has it, it needs a new run
    const outdated = !!result && (result.key !== settingsKey() || (!workerHasResult && result.grain !== grainAmount()));
    runButton.disabled = !source || !manifest || !upscaler.info || tooLarge || nothingToDo || measuring || need.missing || !!running || regraining || (!!result && !outdated);
    const label = settings.factor > 1 ? 'panel.start' : settings.cutout ? 'panel.startCutout' : 'panel.startSharpen';
    $('[data-run-label]', runButton).textContent = t(result ? label.replace('start', 'again') : label);
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
    // editing: only for a cut-out whose settings still match, and when the click-selection models exist
    $('[data-edit-start]', panel).hidden = !result?.alpha || !result.key.endsWith('|true') || !manifest?.models['select-encoder'] || !!running || regraining || !workerHasResult;
    $('[data-bg]').hidden = !(result?.alpha || editor) || (!!running && !editor);   // not while a new result is computed

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
        text = t(p.step === 'sharpen' ? 'progress.sharpenTiles' : 'progress.tiles', { done: p.done, total: p.total });
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

/** the browser's error text, appended to a notice with ?debug */
const detail = (e: unknown) => (DEBUG ? `\n${String(e)}` : '');

async function openFile(picked: File) {
    if (running) return;
    // read once into memory: a phone's picker hands out a reference that can become unreadable later (the picture
    // was shown, starting then failed) – everything afterwards works on this copy
    let file: File;
    try {
        file = new File([await picked.arrayBuffer()], picked.name, { type: picked.type, lastModified: picked.lastModified });
    } catch (e) {
        console.warn('cannot read file:', e);
        showNotice({ id: 'open', icon: 'warning', title: t('notice.read.title'), message: t('notice.read.message', { name: picked.name }) + detail(e), timeout: 12000 });
        return;
    }
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
    } catch (e) {
        console.warn('cannot decode image:', e);
        showNotice({ id: 'open', icon: 'warning', title: t('notice.decode.title'), message: t('notice.decode.message', { name: file.name }) + detail(e), timeout: 10000 });
        return;
    }
    if (editor) endEdit();
    if (source) URL.revokeObjectURL(source.url);
    clearResult();
    const opened: Source = { file, name: file.name || `image.${FORMATS[mime]?.ext ?? 'png'}`, mime, url: URL.createObjectURL(file), width, height, sharpness: null };
    source = opened;
    debugLog('open', source.name, mime, width, height);
    // how sharp is it really? (worker, a fraction of a second) – a soft photo may get the sharpening suggestion
    createImageBitmap(file).then(b => upscaler.analyze(b)).then(sharpness => {
        opened.sharpness = sharpness;
        debugLog('sharpness', sharpness);
        if (source !== opened) return;
        updatePanel();
        suggestSharpen();
    }).catch(e => {
        console.warn('sharpness analysis failed:', e);
        opened.sharpness = { soft: false, width: NaN, halfWidth: NaN, edges: 0 };
        if (source === opened) updatePanel();
    });
    document.body.classList.add('has-image');
    $('#start').hidden = true;
    $('#view-tools').hidden = false;
    compare.setBefore(source.url, width * settings.factor, height * settings.factor);
    updatePanel();
}

function clearResult() {
    if (result) URL.revokeObjectURL(result.url);
    result = null;
    editHistory = null;
    compare.clearAfter();
}

// --- upscale ---

function workerNotice(n: WorkerNotice) {
    if (n.code === 'tile-reduced') {
        showNotice({ id: 'tile', icon: 'info', title: t('notice.tileReduced.title'), message: t('notice.tileReduced.message', { size: n.tileSize }), timeout: 8000 });
    } else {
        showNotice({ id: `cpu-${n.role}`, icon: 'info', title: t('notice.cpuFallback.title'), message: t(`notice.cpuFallback.${n.role}`), timeout: 12000 });
    }
}

async function upscale() {
    if (!source || running) return;
    const need = neededModels();
    if (need.missing || (!need.upscale && !need.cutout)) return;
    const key = settingsKey();
    const suffix = settings.factor > 1 ? 'upscale' : settings.cutout ? 'cutout' : 'sharpen';   // settings may change while it runs
    const src = source;
    // transparency needs a format that can hold it (JPEG cannot) → PNG
    const mime = need.cutout && !ALPHA_FORMATS.has(src.mime) ? 'image/png' : src.mime;
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(src.file);
    } catch (e) {
        // it decoded when opened (same bytes in memory) → most likely out of memory
        console.warn('cannot decode image:', e);
        showNotice({ id: 'open', icon: 'warning', title: t('notice.decodeRun.title'), message: t('notice.decodeRun.message', { name: src.name }) + detail(e) });
        return;
    }
    const grain = grainAmount();
    workerHasResult = false;   // the worker drops the last result when the run starts
    editHistory = null;
    const job = upscaler.run({
        bitmap,
        grain,
        factor: settings.factor,
        upscale: need.upscale,
        cutout: need.cutout,
        sharpen: need.sharpen,
        mime,
        tile: { ...TILING },
        sharpenTile: { ...SHARPEN.tile },
        quality: { ...ENCODE },
        keepUrls: allModelUrls(),
    }, showProgress, workerNotice);
    running = job;
    // again with a result on screen: right of the divider the softened picture instead of the old result (outdated –
    // or empty after a cut-out that found nothing)
    if (result) compare.setWorking(true);
    showProgress({ phase: 'prepare' });
    updatePanel();
    try {
        const r = await job.promise;
        if (source !== src) return;   // another image was opened meanwhile (not possible while running – safety)
        clearResult();
        const name = resultName(src.name, src.mime, r.mime, suffix);
        result = { ...r, url: URL.createObjectURL(r.blob), name, key, grain };
        workerHasResult = true;
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
        compare.setWorking(false);
        showProgress(null);
        cached = await cachedModels();
        updatePanel();
    }
}

/** the result again with the grain of the slider (only written again); repeats while the slider moved meanwhile */
async function regrain() {
    if (!result || !workerHasResult || running || regraining || editor || result.key !== settingsKey()) return;
    const grain = grainAmount();
    if (grain === result.grain) return;
    regraining = true;
    updatePanel();
    showProgress({ phase: 'encode' });
    try {
        const r = await upscaler.regrain(grain, showProgress);
        const old = result;
        result = { ...r, ms: old.ms, url: URL.createObjectURL(r.blob), name: old.name, key: old.key, grain };
        URL.revokeObjectURL(old.url);
        compare.setAfter(result.url, r.width, r.height, r.alpha);
        debugLog('grain', grain, `${Math.round(r.ms)} ms`);
    } catch (e) {
        showNotice({ id: 'error', icon: 'warning', title: t('notice.error.title'), message: `${t(`notice.error.${e instanceof UpscaleError ? e.code : 'unknown'}`)}${DEBUG ? `\n${e}` : ''}` });
    } finally {
        regraining = false;
        showProgress(null);
        updatePanel();
    }
    if (result && result.grain !== grainAmount()) regrain();
}

runButton.addEventListener('click', upscale);
cancelButton.addEventListener('click', () => running?.cancel());

// --- file input, drop, paste ---

const fileInput = $<HTMLInputElement>('#file-input');
for (const b of document.querySelectorAll<HTMLElement>('[data-pick]')) b.addEventListener('click', () => !running && fileInput.click());
fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    // cleared only after reading (same file again → change event again); clearing first can drop the access on phones
    if (f) openFile(f).finally(() => { fileInput.value = ''; });
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
compare.onZoom = z => { zoomLabel.textContent = `${Math.round(z * 100)}${NBSP}%`; brushCursor.hidden = true; };
$('[data-fit]').addEventListener('click', () => compare.fit());
$('[data-actual]').addEventListener('click', () => compare.actualSize());
window.addEventListener('keydown', e => {
    if (editor && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return; }
    if (editor && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return; }
    if (editor && (e.key === '[' || e.key === ']')) { setBrush(editor.radius * (e.key === ']' ? 1.25 : 0.8)); return; }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && running) running.cancel();
    else if (e.key === '0' && source) compare.fit();
    else if (e.key === '1' && source) compare.actualSize();
});

// --- preview backgrounds (transparent results and the edit preview) ---

const BG_KEY = 'upscalr.bg';
let background: PreviewBackground = 'checker';
try { const b = localStorage.getItem(BG_KEY); if (b && b in BACKGROUNDS) background = b as PreviewBackground; } catch { /* storage blocked */ }
function setBackground(bg: PreviewBackground) {
    background = bg;
    compare.setBackground(bg);
    for (const b of document.querySelectorAll<HTMLElement>('[data-bg-value]')) {
        const on = b.dataset.bgValue === bg;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('ring-2', on);
        b.classList.toggle('ring-sky-400', on);
    }
    try { localStorage.setItem(BG_KEY, bg); } catch { /* ignore */ }
}
for (const b of document.querySelectorAll<HTMLElement>('[data-bg-value]')) b.addEventListener('click', () => setBackground(b.dataset.bgValue as PreviewBackground));
setBackground(background);

// --- editing the selection of a cut-out (editor.ts, docs/ui.md "Auswahl bearbeiten") ---

let editor: SelectionEditor | null = null;
let applying = false;
const editBox = $('[data-edit]', panel);
const editStatus = $('[data-edit-status]', editBox);
const brushInput = $<HTMLInputElement>('[data-brush]', editBox);
const brushCursor = $('[data-brush-cursor]');

function editUi() {
    const s = editor?.state();
    $('[data-main]', panel).hidden = !!editor;
    editBox.hidden = !editor;
    if (!editor || !s) { updatePanel(); return; }
    for (const b of editBox.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
        const on = b.dataset.tool === editor.tool;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('bg-sky-500/80', on);
        b.classList.toggle('text-white', on);
        b.classList.toggle('hover:bg-white/10', !on);
    }
    $('[data-edit-hint]', editBox).textContent = t(`edit.hint.${editor.tool}`);
    $('[data-brush-row]', editBox).hidden = !BRUSHES.includes(editor.tool);
    $<HTMLButtonElement>('[data-undo]', editBox).disabled = !s.canUndo || applying;
    $<HTMLButtonElement>('[data-redo]', editBox).disabled = !s.canRedo || applying;
    $<HTMLButtonElement>('[data-reset]', editBox).disabled = !s.edited || applying;
    $<HTMLButtonElement>('[data-edit-apply]', editBox).disabled = applying;
    $<HTMLButtonElement>('[data-edit-cancel]', editBox).disabled = applying;
    if (!editStatus.dataset.sticky) editStatus.textContent = s.busy ? t('edit.status.busy') : s.selectReady ? t('edit.status.ready') : t('edit.status.analysing');
    updatePanel();
}

function setTool(tool: Tool) {
    if (!editor) return;
    editor.tool = tool;
    brushCursor.hidden = true;
    editUi();
}

function setBrush(radius: number) {
    if (!editor) return;
    editor.radius = Math.max(2, Math.min(Number(brushInput.max), Math.round(radius)));
    brushInput.value = String(editor.radius);
    $('[data-brush-value]', editBox).textContent = `${editor.radius * 2}${NBSP}px`;
}

async function startEdit() {
    const encModel = manifest?.models['select-encoder'], decModel = manifest?.models['select-decoder'];
    const enc = fileOf(encModel), dec = fileOf(decModel);
    if (!result || !enc || !dec || !encModel?.input || editor || running) return;
    const width = result.width;
    let selectReady = false;
    editStatus.dataset.sticky = '1';
    editStatus.textContent = t('edit.status.preparing');
    $('[data-edit-start]', panel).setAttribute('disabled', '');
    try {
        const session = await upscaler.editStart({ ...enc, ...encModel.input }, dec, EDIT.maxSide, allModelUrls(), {
            onProgress: p => {
                if (p.phase === 'download') editStatus.textContent = t('edit.status.loading', { loaded: megabytes(p.loaded), total: p.total ? megabytes(p.total) : '?' });
                else if (p.phase === 'prepare') editStatus.textContent = t('edit.status.analysing');
            },
            onNotice: workerNotice,
            onSelectReady: () => {
                selectReady = true;
                delete editStatus.dataset.sticky;
                if (editor) { editor.selectReady = true; editUi(); }
            },
            onSelectError: e => {
                editStatus.dataset.sticky = '1';
                editStatus.textContent = t('edit.status.failed');
                console.warn('click selection unavailable:', e.message);
                if (editor?.tool === 'add' || editor?.tool === 'sub') setTool('keep');
            },
        });
        const inset = Math.max(4, Math.round((4 * Math.max(session.w, session.h)) / 1024));
        editor = new SelectionEditor(session, upscaler, width, inset, editHistory);
        editor.selectReady = selectReady;
        editor.onChange = () => editUi();
        editor.onMessage = key => showNotice({ id: 'edit', icon: 'info', title: t(key), timeout: 4000 });
        brushInput.max = String(Math.max(8, Math.round(Math.max(session.w, session.h) / 6)));
        setBrush(editor.radius);
        compare.setEdit(editor.canvas, editor.pointer);
        compare.setBackground(background);
        if (selectReady) delete editStatus.dataset.sticky;
        setTool(editor.selectReady || !editStatus.dataset.sticky ? 'add' : 'keep');
    } catch (e) {
        console.warn('editing failed:', e);
        showNotice({ id: 'edit', icon: 'warning', title: t('edit.status.failed'), message: DEBUG ? String(e) : '', timeout: 8000 });
        endEdit();
    } finally {
        $('[data-edit-start]', panel).removeAttribute('disabled');
    }
}

function endEdit() {
    compare.setEdit(null, null);
    editor?.destroy();
    editor = null;
    applying = false;
    brushCursor.hidden = true;
    delete editStatus.dataset.sticky;
    editUi();
}

async function applyEdit() {
    if (!editor || !result || applying) return;
    applying = true;
    editUi();
    showProgress({ phase: 'refine' });
    try {
        const grain = grainAmount();
        const history = editor.history();
        const r = await upscaler.editApply(editor.current(), grain, showProgress);
        editHistory = history;
        const old = result;
        result = { ...r, url: URL.createObjectURL(r.blob), name: old.name, key: old.key, grain };
        URL.revokeObjectURL(old.url);
        endEdit();
        compare.setAfter(result.url, r.width, r.height, true);
    } catch (e) {
        showNotice({ id: 'error', icon: 'warning', title: t('notice.error.title'), message: `${t('notice.error.encode')}${DEBUG ? `\n${e}` : ''}` });
        applying = false;
        editUi();
    } finally {
        showProgress(null);
        updatePanel();
    }
}

$('[data-edit-start]', panel).addEventListener('click', startEdit);
$('[data-edit-apply]', editBox).addEventListener('click', applyEdit);
$('[data-edit-cancel]', editBox).addEventListener('click', endEdit);
$('[data-undo]', editBox).addEventListener('click', () => editor?.undo());
$('[data-redo]', editBox).addEventListener('click', () => editor?.redo());
$('[data-reset]', editBox).addEventListener('click', () => editor?.reset());
$<HTMLInputElement>('[data-ghost]', editBox).addEventListener('change', e => editor?.setGhost((e.target as HTMLInputElement).checked));
brushInput.addEventListener('input', () => setBrush(Number(brushInput.value)));
for (const b of editBox.querySelectorAll<HTMLButtonElement>('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool as Tool));

// brush outline: follows the pointer, its size is the brush on screen
compare.onHover = (x, y, inside) => {
    if (!editor || !BRUSHES.includes(editor.tool) || !inside) { brushCursor.hidden = true; return; }
    const r = editor.radius * editor.toScreen(compare.zoom);
    brushCursor.hidden = false;
    brushCursor.style.width = brushCursor.style.height = `${2 * r}px`;
    brushCursor.style.transform = `translate(${x - r}px, ${y - r}px)`;
};

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
if (DEBUG) Object.assign(globalThis, { __upscalr: { openFile, upscale, compare, upscaler, gpuErrors: upscaler.gpuErrors, get result() { return result; }, get editor() { return editor; } } });
