// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Cross-origin isolation: SharedArrayBuffer for the multi-threaded CPU backend of the inference runtime.
// In production public/.htaccess sets the same headers (GitHub Pages: public/coi-serviceworker.js).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// App version ("About"): major.minor from package.json (raised by hand), patch = number of git commits – counts up
// with every commit, the same commit always gives the same version. "-dev": built with uncommitted changes.
// Without git (source archive): package.json as it is. CI needs the full history (fetch-depth: 0).
function appVersion() {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const git = (/** @type {string} */ args) => execSync(`git ${args}`, { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const commits = git('rev-list --count HEAD');
    const dirty = git('status --porcelain') !== '';
    return `${version.split('.').slice(0, 2).join('.')}.${commits}${dirty ? '-dev' : ''}`;
  } catch {
    return version;
  }
}

// version of the inference runtime: its wasm files are copied to public/ort/<version>/ (scripts/copy-ort.mjs)
const ortVersion = JSON.parse(readFileSync(new URL('./node_modules/onnxruntime-web/package.json', import.meta.url), 'utf8')).version;

// .env is not loaded into process.env for the config itself (prefix '' = all keys, read here only)
const fileEnv = loadEnv(process.env.NODE_ENV === 'production' ? 'production' : 'development', process.cwd(), '');

export default defineConfig({
  // Sub directory on the server: BASE_PATH=/upscalr/ npm run build (default: domain root).
  // All runtime paths use import.meta.env.BASE_URL or are relative.
  base: process.env.BASE_PATH || '/',
  outDir: process.env.OUT_DIR || './dist',
  // Public origin for absolute og:image / og:url links: SITE_URL in .env or the shell
  site: process.env.SITE_URL || fileEnv.SITE_URL || undefined,
  server: {
    host: true,
    port: 4321,
    headers: isolationHeaders,
  },
  vite: {
    plugins: [tailwindcss()],
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    worker: { format: 'es' },
    build: { sourcemap: !!process.env.SOURCEMAP },
    resolve: {
      // the runtime build that loads its wasm + loader from public/ort/ (wasmPaths) instead of bundling the loader:
      // its pthread workers then load only the loader module, never our worker chunk
      alias: [{ find: /^onnxruntime-web\/webgpu$/, replacement: fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs', import.meta.url)) }],
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion()),
      __ORT_VERSION__: JSON.stringify(ortVersion),
    },
    optimizeDeps: { exclude: ['onnxruntime-web'] },
  },
});
