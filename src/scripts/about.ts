// "About" window: name, description, author, version, the compute backend and the open-source projects and models
// UPSCALR is built on (with link, licence and licence text – list in libraries.ts, also used for README.md).
// Author data: ABOUT in config.ts, version from the build (astro.config.mjs). Purpose texts: about.libs.<id>.
import { ABOUT } from './config';
import { LANGUAGES, getLanguage, setLanguage, t } from './i18n';
import { RUNTIME, MODELS, BUILD, type Library } from './libraries';
import { SELECT } from './ui-controls';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};
const link = (href: string, text: string) => {
    const a = el('a', 'text-sky-400 hover:underline', text);
    a.href = href;
    if (!href.startsWith('mailto:')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
};

/** @param compute  e.g. "Grafikkarte (WebGPU) · <adapter>" */
export function buildAbout({ compute = '' }: { compute?: string } = {}) {
    const root = el('div', 'flex flex-col gap-3 select-text');
    const head = el('div');
    head.append(el('div', 'text-base font-semibold text-white', 'UPSCALR'), el('div', 'text-white/60', t('about.description')));
    root.append(head);

    const facts = el('div', 'grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-1');
    const fact = (label: string, value: string | HTMLElement) => facts.append(el('span', 'text-white/50', label), typeof value === 'string' ? el('span', '', value) : value);
    fact(t('about.author'), ABOUT.author || '–');
    if (ABOUT.email) fact(t('about.email'), link(`mailto:${ABOUT.email}`, ABOUT.email));
    fact(t('about.version'), __APP_VERSION__);
    if (compute) fact(t('about.compute'), compute);
    const lang = el('select', SELECT + ' w-auto');
    for (const code of LANGUAGES) {
        const o = el('option', '', t(`languages.${code}`));
        o.value = code;
        o.selected = code === getLanguage();
        lang.append(o);
    }
    lang.onchange = () => setLanguage(lang.value).then(() => document.dispatchEvent(new CustomEvent('upscalr:language')));
    fact(t('about.language'), lang);
    root.append(facts, el('div', 'text-white', t('about.madeWith')));

    const list = (title: string, items: Library[]) => {
        const box = el('div', 'flex flex-col gap-1.5');
        box.append(el('div', 'mt-1 border-t border-white/10 pt-3 font-medium text-white/90', title));
        for (const item of items) {
            const row = el('div', 'flex items-baseline gap-2');
            const text = el('div', 'min-w-0 flex-1');
            text.append(link(item.url, item.name), el('div', 'text-white/50', t(`about.libs.${item.id}`)));
            const badge = el('span', 'shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60');
            if (item.notice) badge.append(link(import.meta.env.BASE_URL + item.notice, item.license));
            else badge.textContent = item.license;
            row.append(text, badge);
            box.append(row);
        }
        return box;
    };
    root.append(el('div', 'mt-1 border-t border-white/10 pt-3 text-white/70', t('about.openSource')));
    root.append(list(t('about.runtime'), RUNTIME), list(t('about.models'), MODELS), list(t('about.build'), BUILD));
    return root;
}
