// Image formats: what a file is, what the result is called, how it is written (docs/image-io.md).
// Decoding is the browser's (createImageBitmap); writing uses the canvas encoders (PNG, JPEG, WebP – whatever the
// browser offers) and an own BMP writer. Formats the browser cannot write fall back to PNG (lossless) and say so.

export interface FormatInfo { mime: string; ext: string; label: string }

/** formats the app knows by MIME type; `ext` = extension used when the file name has none */
export const FORMATS: Record<string, FormatInfo> = {
    'image/png': { mime: 'image/png', ext: 'png', label: 'PNG' },
    'image/jpeg': { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
    'image/webp': { mime: 'image/webp', ext: 'webp', label: 'WebP' },
    'image/avif': { mime: 'image/avif', ext: 'avif', label: 'AVIF' },
    'image/gif': { mime: 'image/gif', ext: 'gif', label: 'GIF' },
    'image/bmp': { mime: 'image/bmp', ext: 'bmp', label: 'BMP' },
    'image/x-icon': { mime: 'image/x-icon', ext: 'ico', label: 'ICO' },
};
const BY_EXT: Record<string, string> = {
    png: 'image/png', apng: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
    webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp', dib: 'image/bmp', ico: 'image/x-icon',
};
const ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-ms-bmp': 'image/bmp', 'image/vnd.microsoft.icon': 'image/x-icon', 'image/apng': 'image/png' };

/** MIME type of a file: the browser's guess, else the extension, else the first bytes */
export async function detectMime(file: File): Promise<string> {
    const typed = ALIASES[file.type] ?? file.type;
    if (FORMATS[typed]) return typed;
    const ext = file.name.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase();
    if (ext && BY_EXT[ext]) return BY_EXT[ext];
    const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
    if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (ascii(4, 8) === 'ftyp' && /avi[fs]/.test(ascii(8, 12))) return 'image/avif';
    if (ascii(0, 3) === 'GIF') return 'image/gif';
    if (ascii(0, 2) === 'BM') return 'image/bmp';
    return typed || 'application/octet-stream';
}

/** formats that can hold transparency (BMP: own 32-bit writer; AVIF/GIF are written as PNG anyway) */
export const ALPHA_FORMATS = new Set(['image/png', 'image/webp', 'image/bmp', 'image/avif', 'image/gif', 'image/x-icon']);

/**
 * Name of the result: "<name>-<suffix>.<original extension>" (spelling of the extension kept, e.g. .JPG) – suffix
 * "upscale", or "cutout" when only the background was removed (1×); if the result had to be written in another
 * format, that format's extension.
 */
export function resultName(original: string, sourceMime: string, resultMime: string, suffix = 'upscale'): string {
    const m = original.match(/^(.*?)(\.([^./\\]+))?$/)!;
    const base = m[1] || 'image';
    const ext = m[3];
    const sameFormat = (ALIASES[sourceMime] ?? sourceMime) === resultMime;
    const keepExt = sameFormat && ext && BY_EXT[ext.toLowerCase()] === resultMime;
    return `${base}-${suffix}.${keepExt ? ext : FORMATS[resultMime]?.ext ?? 'png'}`;
}

/** BMP writer: 24 bit, or 32 bit with alpha (BITMAPV4HEADER with channel masks) when the image is not opaque */
export function encodeBmp(rgba: Uint8ClampedArray, width: number, height: number, alpha: boolean): Blob {
    const bpp = alpha ? 4 : 3;
    const rowBytes = alpha ? width * 4 : (width * 3 + 3) & ~3;
    const headerSize = alpha ? 108 : 40;
    const offset = 14 + headerSize;
    const size = offset + rowBytes * height;
    if (size > 0xffffffff) throw new Error('BMP larger than 4 GB');
    const head = new DataView(new ArrayBuffer(offset));
    head.setUint8(0, 0x42); head.setUint8(1, 0x4d);
    head.setUint32(2, size, true);
    head.setUint32(10, offset, true);
    head.setUint32(14, headerSize, true);
    head.setInt32(18, width, true);
    head.setInt32(22, -height, true);           // top-down rows
    head.setUint16(26, 1, true);
    head.setUint16(28, bpp * 8, true);
    head.setUint32(30, alpha ? 3 : 0, true);    // BI_BITFIELDS / BI_RGB
    head.setUint32(34, rowBytes * height, true);
    head.setInt32(38, 2835, true);              // 72 dpi
    head.setInt32(42, 2835, true);
    if (alpha) {
        head.setUint32(54, 0x00ff0000, true);   // red mask
        head.setUint32(58, 0x0000ff00, true);
        head.setUint32(62, 0x000000ff, true);
        head.setUint32(66, 0xff000000, true);   // alpha mask
        head.setUint32(70, 0x73524742, true);   // 'sRGB'
    }
    // pixel rows in chunks (a single huge ArrayBuffer is avoided – the Blob joins the parts)
    const parts: BlobPart[] = [head.buffer];
    const rowsPerChunk = Math.max(1, Math.floor((16 << 20) / rowBytes));
    for (let y0 = 0; y0 < height; y0 += rowsPerChunk) {
        const rows = Math.min(rowsPerChunk, height - y0);
        const chunk = new Uint8Array(rowBytes * rows);
        for (let y = 0; y < rows; y++) {
            let s = (y0 + y) * width * 4, d = y * rowBytes;
            for (let x = 0; x < width; x++, s += 4) {
                chunk[d++] = rgba[s + 2]; chunk[d++] = rgba[s + 1]; chunk[d++] = rgba[s];
                if (alpha) chunk[d++] = rgba[s + 3];
            }
        }
        parts.push(chunk);
    }
    return new Blob(parts, { type: 'image/bmp' });
}

/**
 * Write the result in `mime` (worker or page). BMP: own writer; PNG/JPEG/WebP and whatever else the canvas offers:
 * OffscreenCanvas.convertToBlob – a browser that cannot write the type returns PNG instead (spec), the caller sees
 * that in blob.type.
 */
export async function encodeImage(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, mime: string, alpha: boolean,
    quality: { jpeg: number; webp: number }): Promise<Blob> {
    if (mime === 'image/bmp') return encodeBmp(rgba, width, height, alpha);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas');
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    const q = mime === 'image/jpeg' ? quality.jpeg : mime === 'image/webp' ? quality.webp : undefined;
    const blob = await canvas.convertToBlob({ type: mime, quality: q });
    canvas.width = canvas.height = 0;   // free the backing store now, not at the next GC
    return blob;
}
