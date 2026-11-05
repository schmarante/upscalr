// Model files in the Cache API (docs/models.md "Cache"): downloaded once with progress, afterwards read from the cache –
// also offline. File names carry a content hash, so a new model is a new URL; entries not in use any more are removed.
// The Cache API may be missing or blocked (private mode, storage full) – then the model is simply downloaded.
import { MODEL_CACHE } from './config';

async function openCache(): Promise<Cache | null> {
    try { return typeof caches === 'undefined' ? null : await caches.open(MODEL_CACHE); } catch { return null; }
}

/** model bytes from the cache or the network; onProgress(loaded, total) while downloading */
export async function loadModel(url: string, expectedBytes: number, onProgress: (loaded: number, total: number) => void,
    signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const cache = await openCache();
    try {
        const hit = await cache?.match(url);
        if (hit) {
            const bytes = new Uint8Array(await hit.arrayBuffer());
            if (!expectedBytes || bytes.length === expectedBytes) return bytes;
            await cache!.delete(url);   // truncated entry
        }
    } catch { /* unreadable entry – download again */ }

    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    // the size from the manifest: Content-Length counts compressed bytes when the server compresses
    const total = expectedBytes || Number(res.headers.get('Content-Length')) || 0;
    const bytes = new Uint8Array(new ArrayBuffer(total));
    const reader = res.body.getReader();
    let loaded = 0, chunks: Uint8Array[] | null = null;
    onProgress(0, total);
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!chunks && loaded + value.length <= bytes.length) bytes.set(value, loaded);
        else (chunks ??= [bytes.subarray(0, loaded)]).push(value);   // size unknown or longer than announced
        loaded += value.length;
        onProgress(loaded, total);
    }
    let out: Uint8Array<ArrayBuffer>;
    if (chunks) {
        out = new Uint8Array(loaded);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
    } else {
        out = bytes.subarray(0, loaded);
    }
    if (expectedBytes && out.length !== expectedBytes) throw new Error(`model download incomplete (${out.length} of ${expectedBytes} bytes)`);
    try {
        await cache?.put(url, new Response(out, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch { /* quota or private mode: works without the cache */ }
    return out;
}

/** remove cached models whose URL is not in `keep` */
export async function pruneModels(keep: string[]) {
    const cache = await openCache();
    if (!cache) return;
    try {
        const wanted = new Set(keep);
        for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
    } catch { /* ignore */ }
}

/** URLs of models already in the cache (the panel marks them as "ready offline") */
export async function cachedModels(): Promise<Set<string>> {
    const cache = await openCache();
    try { return new Set((await cache?.keys() ?? []).map(r => r.url)); } catch { return new Set(); }
}
