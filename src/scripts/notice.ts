// Notices: non-blocking cards at the top centre in the style of the panels (black, translucent, blur, rounded) –
// for things the user should know but need not answer at once: no WebGPU on this device, a format the browser cannot
// write, an image too large for the browser …
//   showNotice({ id, icon: 'warning'|'info', title, message, actions: [{ label, onClick, primary }], timeout })
// The same id replaces its card instead of stacking it. Returns { close }.
import { icon } from './icons';

export interface NoticeAction { label: string; onClick?: () => void; primary?: boolean }
export interface NoticeOptions {
    id?: string | null;
    icon?: 'warning' | 'info';
    title: string;
    message?: string;
    actions?: NoticeAction[];
    /** ms until it closes by itself (0 = stays) */
    timeout?: number;
}

const BUTTON = 'rounded px-2.5 py-1 outline-none transition-colors';
const ICONS = {
    warning: icon('warning', 'mt-px size-4 shrink-0 fill-amber-400'),
    info: icon('info', 'mt-px size-4 shrink-0 fill-sky-400'),
};
const ICON_CLOSE = icon('close', 'size-3.5');

let stack: HTMLDivElement | null = null;
const open = new Map<string, { close: () => void }>();

function container() {
    if (stack) return stack;
    stack = document.createElement('div');
    stack.className = 'pointer-events-none fixed top-5 left-1/2 z-40 flex w-[min(26rem,calc(100vw-2.5rem))] -translate-x-1/2 flex-col gap-2 text-xs text-white/90';
    stack.setAttribute('aria-live', 'polite');
    document.body.append(stack);
    return stack;
}

export function showNotice({ id = null, icon = 'info', title, message = '', actions = [], timeout = 0 }: NoticeOptions) {
    if (id && open.has(id)) open.get(id)!.close();
    const card = document.createElement('div');
    card.className = 'pointer-events-auto flex gap-2.5 rounded-lg bg-black/60 px-3.5 py-3 shadow-2xl backdrop-blur-sm transition-[opacity,transform] duration-300 opacity-0 -translate-y-1';
    card.setAttribute('role', 'status');
    card.insertAdjacentHTML('beforeend', ICONS[icon] || ICONS.info);
    const body = document.createElement('div');
    body.className = 'min-w-0 flex-1';
    const head = document.createElement('div');
    head.className = 'font-medium text-white';
    head.textContent = title;
    body.append(head);
    if (message) {
        const text = document.createElement('div');
        text.className = 'mt-0.5 whitespace-pre-line text-white/70 select-text';   // e.g. an error message to copy
        text.textContent = message;
        body.append(text);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
        if (!card.isConnected) return;
        clearTimeout(timer);
        if (id) open.delete(id);
        card.classList.add('opacity-0', '-translate-y-1');
        setTimeout(() => card.remove(), 300);
    };
    if (actions.length) {
        const row = document.createElement('div');
        row.className = 'mt-2 flex flex-wrap gap-1.5';
        for (const a of actions) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `${BUTTON} ${a.primary ? 'bg-sky-500/80 text-white hover:bg-sky-500' : 'bg-white/10 text-white/80 hover:bg-white/20'}`;
            b.textContent = a.label;
            b.onclick = () => { close(); a.onClick?.(); };
            row.append(b);
        }
        body.append(row);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'self-start text-white/40 transition-colors hover:text-white';
    x.innerHTML = ICON_CLOSE;
    x.onclick = close;
    card.append(body, x);
    container().append(card);
    requestAnimationFrame(() => card.classList.remove('opacity-0', '-translate-y-1'));
    if (timeout > 0) timer = setTimeout(close, timeout);
    const handle = { close };
    if (id) open.set(id, handle);
    return handle;
}
