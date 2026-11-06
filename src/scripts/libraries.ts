// Open-source projects and models UPSCALR is built on – single source for the "About" window (about.ts) and the
// "Built with" section of README.md (scripts/sync-readme.mjs, runs before every build). Purpose texts:
// about.libs.<id> in the language files. Pure data: also imported by Node.
// Third-party names appear only here (and in the licence files): the licences require the notice; the interface
// itself never names them (BSD-3-Clause also forbids using the authors' names to promote this app).
export interface Library { id: string; name: string; license: string; url: string; notice?: string }

// runtime: shipped to the browser
export const RUNTIME: Library[] = [
    { id: 'ort', name: 'ONNX Runtime Web', license: 'MIT', url: 'https://github.com/microsoft/onnxruntime', notice: 'licenses/onnxruntime.txt' },
    { id: 'coi', name: 'coi-serviceworker', license: 'MIT', url: 'https://github.com/gzuidhof/coi-serviceworker', notice: 'licenses/coi-serviceworker.txt' },
];
// model weights (converted to ONNX by scripts/convert-models.mjs)
export const MODELS: Library[] = [
    { id: 'realEsrgan', name: 'Real-ESRGAN', license: 'BSD-3-Clause', url: 'https://github.com/xinntao/Real-ESRGAN', notice: 'licenses/real-esrgan.txt' },
    { id: 'birefnet', name: 'BiRefNet', license: 'MIT', url: 'https://github.com/ZhengPeng7/BiRefNet', notice: 'licenses/birefnet.txt' },
    { id: 'sam', name: 'SAM 2.1 (Segment Anything)', license: 'Apache-2.0', url: 'https://github.com/facebookresearch/sam2', notice: 'licenses/sam2.txt' },
    { id: 'nafnet', name: 'NAFNet', license: 'MIT', url: 'https://github.com/megvii-research/NAFNet', notice: 'licenses/nafnet.txt' },
];
// build tools
export const BUILD: Library[] = [
    { id: 'astro', name: 'Astro', license: 'MIT', url: 'https://astro.build' },
    { id: 'vite', name: 'Vite', license: 'MIT', url: 'https://vite.dev' },
    { id: 'tailwind', name: 'Tailwind CSS', license: 'MIT', url: 'https://tailwindcss.com' },
    { id: 'typescript', name: 'TypeScript', license: 'Apache-2.0', url: 'https://www.typescriptlang.org' },
];
