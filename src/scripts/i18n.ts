// Internationalisation: all user-facing texts come from language files in src/i18n/<lang>.json
// (e.g. de_de.json). Keys are nested objects, addressed with dots: t('panel.factor').
//
// - Interpolation: "{count} tiles" + t(key, { count: 3 })
// - Plurals: a value may be an object { one, other } (optionally zero/two/few/many); the form is
//   chosen via Intl.PluralRules from params.count.
// - Fallback chain: current language -> de_de (reference language) -> the key itself (and a
//   console warning in ?debug, so missing keys are easy to spot).
// - Language choice: ?lang=<code> > stored choice (localStorage) > browser language > de_de.
// - Static markup: elements with data-i18n="key" get their textContent, data-i18n-title="key" their
//   title attribute, data-i18n-aria="key" their aria-label (applyDom()). data-i18n-html="key" allows
//   simple formatting in the value (<strong>, <b>, <em>, <i>, <br>) – everything else stays text
//   (formatHtml), so language files can never inject markup.
//
// The worker does not use this module: it sends error codes, the main thread translates them.

type Dict = { [key: string]: string | Dict };
type Params = Record<string, string | number>;

// Only the language in use is loaded (plus the reference language for keys it lacks) – each file is a chunk of its
// own; top-level await: modules importing this one start once the texts are there.
const FILES: Record<string, () => Promise<Dict>> = Object.fromEntries(
    Object.entries(import.meta.glob<Dict>('../i18n/*.json', { import: 'default' })).map(([path, load]) => [path.match(/([\w-]+)\.json$/)![1], load]),
);
const DICTS: Record<string, Dict> = {};

export const DEFAULT_LANGUAGE = 'de_de';
const STORAGE_KEY = 'upscalr.lang';
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

/** Available language codes */
export const LANGUAGES = Object.keys(FILES).sort();

// language code de_de -> BCP 47 locale de-DE (number/date formatting, plural rules)
const toLocale = (code: string) => code.replace('_', '-').replace(/-(\w+)$/, (_, r: string) => '-' + r.toUpperCase());

function pickLanguage(): string {
    const candidates: (string | null | undefined)[] = [];
    try { candidates.push(new URLSearchParams(location.search).get('lang')); } catch { /* no location */ }
    try { candidates.push(localStorage.getItem(STORAGE_KEY)); } catch { /* storage blocked */ }
    try { candidates.push(...(navigator.languages || [navigator.language])); } catch { /* no navigator */ }
    for (const c of candidates) {
        if (!c) continue;
        const code = c.toLowerCase().replace('-', '_');
        if (FILES[code]) return code;
        const prefix = Object.keys(FILES).find(k => k.startsWith(code.split('_')[0] + '_'));
        if (prefix) return prefix;
    }
    return DEFAULT_LANGUAGE;
}

let language = pickLanguage();
let pluralRules = new Intl.PluralRules(toLocale(language));
const loadDict = async (code: string) => { DICTS[code] ??= await FILES[code](); };
await Promise.all([loadDict(DEFAULT_LANGUAGE), loadDict(language)]);

/** Current language code (e.g. de_de) */
export const getLanguage = () => language;
/** BCP 47 locale of the current language (e.g. de-DE) for toLocaleString & co. */
export const getLocale = () => toLocale(language);

/** Switch language (stored for the next visit; its file is loaded first); resolves false for unknown codes */
export async function setLanguage(code: string): Promise<boolean> {
    if (!FILES[code]) return false;
    await loadDict(code);
    language = code;
    pluralRules = new Intl.PluralRules(toLocale(code));
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* storage blocked */ }
    applyDom();
    return true;
}

const lookup = (dict: Dict | undefined, key: string): string | Dict | undefined =>
    key.split('.').reduce<string | Dict | undefined>((node, part) => (node == null || typeof node === 'string' ? undefined : node[part]), dict);
const warned = new Set<string>();

/**
 * Translate a key.
 * @param key  dotted path, e.g. 'panel.factor'
 * @param params  values for {placeholders}; params.count selects the plural form
 */
export function t(key: string, params?: Params): string {
    let value = lookup(DICTS[language], key);
    if (value === undefined && language !== DEFAULT_LANGUAGE) value = lookup(DICTS[DEFAULT_LANGUAGE], key);
    if (value === undefined) {
        if (DEBUG && !warned.has(key)) { warned.add(key); console.warn('[i18n] missing key:', key); }
        return key;
    }
    if (typeof value === 'object') {
        const form = params && typeof params.count === 'number' ? pluralRules.select(params.count) : 'other';
        const picked = value[form] ?? value.other;
        value = typeof picked === 'string' ? picked : key;
    }
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (m, name: string) => (params[name] === undefined ? m : String(params[name])));
}

/** Does a key exist (in the current or the reference language)? */
export const has = (key: string) => lookup(DICTS[language], key) !== undefined || lookup(DICTS[DEFAULT_LANGUAGE], key) !== undefined;

const ALLOWED_TAGS = /^<\/?(strong|b|em|i)>$|^<br\s*\/?>$/i;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Value as HTML with only simple formatting allowed: <strong> <b> <em> <i> (without attributes) and <br>;
 * any other tag or text is escaped. Same function at build time (index.astro) and at runtime.
 */
export function formatHtml(value: unknown): string {
    return String(value).split(/(<[^>]*>)/).map(part => (ALLOWED_TAGS.test(part) ? part.toLowerCase() : escapeHtml(part))).join('');
}

/** Translate static markup: data-i18n / data-i18n-html / data-i18n-title / data-i18n-aria */
export function applyDom(root: ParentNode | null = typeof document !== 'undefined' ? document : null) {
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
    for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) el.innerHTML = formatHtml(t(el.dataset.i18nHtml!));
    for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle!);
    for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria!));
    if (typeof document !== 'undefined') document.documentElement.lang = getLocale();
}
