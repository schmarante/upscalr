// Converted models as a release of this repository (docs/deployment.md "Modelle aus dem eigenen Release"): the deploy
// and developers get the ONNX files from there – no third-party server (user's priority, 06.11.2026). Only when the
// model list or the converter changes are the published checkpoints downloaded once (npm run models, the deploy then
// keeps the result as a new release). The browser loads the models from the site itself, never from here.
//
//   node scripts/models-release.mjs key
//        release tag for the current state: models-<hash of the model list and the converter>
//   node scripts/models-release.mjs fetch [--repo owner/name] [--out dir] [--base url]   (npm run models:fetch)
//        manifest.json and every model it lists from that release into public/models/, size and sha256 checked;
//        exit code 2 = no release for this state yet (then npm run models – the deploy publishes it);
//        --base: another address with the same files instead of the release (tests)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};

/** everything that decides the content of the converted files (another state = another release) */
function inputs() {
    const lib = fs.readdirSync(path.join(root, 'scripts/lib')).filter(f => f.endsWith('.mjs')).sort();
    return ['scripts/models.json', 'scripts/convert-models.mjs', ...lib.map(f => `scripts/lib/${f}`)];
}

export function releaseTag() {
    const h = crypto.createHash('sha256');
    for (const f of inputs()) h.update(`${f}\0`).update(fs.readFileSync(path.join(root, f))).update('\0');
    return `models-${h.digest('hex').slice(0, 12)}`;
}

/** owner/name: --repo, the Actions variable, or the GitHub remote of this clone */
function repository() {
    const given = arg('repo', process.env.GITHUB_REPOSITORY);
    if (given) return given;
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!m) throw new Error('the remote "origin" is not a GitHub repository – pass --repo owner/name');
    return m[1];
}

/** GET with retries (release downloads answer 5xx now and then); 404 → null */
async function download(url, attempts = 5) {
    for (let i = 1; ; i++) {
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) {
            if (i >= attempts) throw new Error(`download failed (${url}): ${e.message}`);
            const wait = 2 ** i;
            console.log(`  download failed (${e.message}), retry in ${wait} s …`);
            await new Promise(r => setTimeout(r, wait * 1000));
        }
    }
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const mb = n => `${(n / 1048576).toFixed(1)} MB`;

async function fetchModels() {
    const tag = releaseTag();
    const base = arg('base', null) ?? `https://github.com/${repository()}/releases/download/${tag}/`;
    const outDir = path.resolve(root, arg('out', 'public/models'));
    console.log(`models from the release ${tag}`);
    // the manifest is uploaded last – without it the release does not exist (yet) or is incomplete
    const manifestBuf = await download(`${base}manifest.json`);
    if (!manifestBuf) {
        console.log(`no release ${tag} yet (models or converter changed): npm run models converts them from the published checkpoints, the next deploy publishes the release`);
        process.exit(2);
    }
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    fs.mkdirSync(outDir, { recursive: true });
    const keep = new Set();
    for (const [id, model] of Object.entries(manifest.models)) {
        for (const v of Object.values(model.variants)) {
            keep.add(v.file);
            const file = path.join(outDir, v.file);
            if (fs.existsSync(file) && fs.statSync(file).size === v.bytes && sha256(fs.readFileSync(file)) === v.sha256) {
                console.log(`  ${v.file}: present`);
                continue;
            }
            const buf = await download(`${base}${v.file}`);
            if (!buf) throw new Error(`${id}: ${v.file} missing in the release ${tag}`);
            if (buf.length !== v.bytes || sha256(buf) !== v.sha256) throw new Error(`${id}: ${v.file} does not match the manifest (size or sha256)`);
            fs.writeFileSync(file, buf);
            console.log(`  ${v.file}: ${mb(buf.length)}`);
        }
    }
    // files of older states are removed (like the converter does)
    for (const f of fs.readdirSync(outDir)) if (f.endsWith('.onnx') && !keep.has(f)) fs.rmSync(path.join(outDir, f));
    fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestBuf);
    console.log(`manifest: ${path.relative(root, path.join(outDir, 'manifest.json'))}`);
}

const cmd = process.argv[2];
if (cmd === 'key') console.log(releaseTag());
else if (cmd === 'fetch') await fetchModels();
else {
    console.error('usage: node scripts/models-release.mjs key | fetch [--repo owner/name] [--out dir] [--base url]');
    process.exit(1);
}
