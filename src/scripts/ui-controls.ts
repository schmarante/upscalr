// Shared look of the panel inputs – every control looks and behaves the same (same classes as in RINDR).

/** select */
export const SELECT = 'min-w-0 rounded bg-white/10 px-1.5 py-0.5 text-left text-white outline-none focus:bg-white/20 cursor-pointer';

/** segmented control button: base, active, inactive */
export const SEG = 'flex h-7 min-w-8 items-center justify-center rounded px-1.5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-sky-400 disabled:opacity-40 disabled:cursor-not-allowed';
export const SEG_ON = 'bg-sky-500/80 text-white';
export const SEG_OFF = 'text-white/70 hover:bg-white/10';

/** primary / secondary buttons */
export const BUTTON = 'flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:opacity-40';
export const BUTTON_PRIMARY = `${BUTTON} bg-sky-500/80 text-white hover:bg-sky-500 disabled:hover:bg-sky-500/80`;
export const BUTTON_SECONDARY = `${BUTTON} bg-white/10 text-white/80 hover:bg-white/20`;

/**
 * Segmented control: buttons with data-value inside `group`; marks the active one and calls onChange on click.
 * Returns a setter for the value (e.g. after restoring settings).
 */
export function segmented(group: HTMLElement, onChange: (value: string) => void) {
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button[data-value]')];
    const set = (value: string) => {
        for (const b of buttons) {
            const on = b.dataset.value === value;
            b.setAttribute('aria-pressed', String(on));
            b.className = `${SEG} ${on ? SEG_ON : SEG_OFF}`;
        }
    };
    for (const b of buttons) b.addEventListener('click', () => { set(b.dataset.value!); onChange(b.dataset.value!); });
    return set;
}
