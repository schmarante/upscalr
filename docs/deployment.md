# Build, Betrieb und Testen

npm-Skripte, DDEV, `dist/`, Unterverzeichnis, GitHub Pages, Cross-Origin-Isolation, Sicherheits-Header, Caching, Testweg.

## npm-Skripte

| Skript | Was |
|---|---|
| `npm run models` | Modelle konvertieren → `public/models/` (`docs/models.md`); einmal nach dem Klonen und nach Änderungen an `scripts/models.json` |
| `npm run build` | vorher `sync-readme.mjs` (README „Built with“) + `copy-ort.mjs` (Runtime-wasm), dann `astro build` → **`dist/`** |
| `npm run dev` | Dev-Server (Port 4321, mit COOP/COEP-Headern); vorher `copy-ort.mjs` |
| `npm test` | Kachel-Tests in Node (`tests/*.test.ts`, Node führt TypeScript direkt aus) |
| `npm run check` | `astro check` (TypeScript strikt) |

Node ≥ 22 (DDEV und CI: 24). Auf dem Host ist Node 16 → Befehle im Container: `ddev exec npm run build`.

## DDEV

Projekt `upscalr`, Docroot `dist` → https://upscalr.dev.dasachtegebot.local/ liefert den letzten Build (Apache, `public/.htaccess` wird mitkopiert). Die Datenbank wird nicht gebraucht.

## Build-Ausgabe (`dist/`)

`index.html`, `_astro/` (Seite ~30 KB, Worker ~77 KB, Sprachdateien je ~4 KB, CSS), `ort/<version>/` (Runtime-Loader + wasm ~28 MB), `models/` (6 Modelldateien ~129 MB + `manifest.json`), `licenses/`, Icons, `coi-*.js`, `.htaccess`.

## Unterverzeichnis / öffentliche Adresse

`BASE_PATH=/upscalr/ npm run build` (`base` in astro.config.mjs); alle Laufzeitpfade über `import.meta.env.BASE_URL` (`publicUrl()` in upscaler.ts) – geprüft mit Build unter `/sub/`. Absolute `og:image`/`og:url` nur mit `SITE_URL` (`.env`, siehe `.env.example`). Paralleler Testbuild: `OUT_DIR=./dist/x BASE_PATH=/x/`.

## GitHub Pages (`.github/workflows/static.yml`)

**Ablauf (Entscheidung des Nutzers, 05.11.2026):** gearbeitet wird in `develop` (Standard-Branch auf GitHub); ist ein Stand fertig, wird `develop` nach `master` übernommen – der Push auf `master` löst den Deploy aus.

Bei Push auf `master` (und von Hand): `npm ci` → `npm test` → Checkpoints aus `actions/cache` (Schlüssel = Hash von `models.json`) → `npm run models` → `npm run build` mit `BASE_PATH`/`SITE_URL` aus `configure-pages` (Repo-Variable `SITE_URL` hat Vorrang) → `dist/` veröffentlichen. In den Pages-Einstellungen muss die Quelle „GitHub Actions“ sein (umgestellt am 05.11.2026, vorher „Deploy from a branch“). Ziel: GitHub Pages dieses Repos (`https://<konto>.github.io/upscalr/`).

**Größe:** GitHub Pages veröffentlicht höchstens 1 GB. `dist/` hatte 655 MB; das Modell zum Schärfen kommt deshalb nur als fp16 (129 MB statt zusätzlich 259 MB fp32, `precisions` in `models.json`) → rund 790 MB. Vor jedem neuen großen Modell nachrechnen. Sein Checkpoint (271 MB) kommt von Google Drive (offizielle Quelle; einmal pro Änderung an `models.json`, danach aus dem Actions-Cache) – scheitert der Download dort, Quelle tauschen (Prüfsumme bleibt gleich).

Fallstrick: Die Umgebung `github-pages` kann Deploys auf bestimmte Branches beschränken. Erster Lauf (05.11.2026): Build ok, Deploy abgelehnt – „Branch "master" is not allowed to deploy to github-pages due to environment protection rules“. Abhilfe: Settings → Environments → `github-pages` → Deployment branches: `master` erlauben.

## Cross-Origin-Isolation

Nötig für `SharedArrayBuffer` = mehrere Threads im CPU-Backend (WebGPU braucht es nicht).
- Eigener Server: `public/.htaccess` sendet COOP/COEP.
- GitHub Pages (kann keine Header): `public/coi-serviceworker.js` (coi-serviceworker 0.1.7, MIT, mit den Änderungen aus RINDR: Sicherheits-Header, Wiederholung bei Netzfehler, Neuladen erst wenn aktiv) – erstes Skript im `<head>`, einmal Neuladen beim ersten Besuch. Meldungen nur mit `?debug` (`public/coi-config.js`, Datei statt Inline-Skript wegen CSP). Ist die Seite schon isoliert, registriert er sich nicht.

## Sicherheit

- **Content-Security-Policy** als `<meta>` in index.astro (nur im Produktions-Build): nur eigene Skripte, `'wasm-unsafe-eval'` (Runtime), `worker-src 'self' blob:`, **`connect-src 'self'`** – die Seite kann technisch nichts an fremde Server schicken (Bilder bleiben lokal), Bilder als `blob:`/`data:`.
- Nur als Header möglich (frame-ancestors, X-Frame-Options, X-Content-Type-Options, Referrer-/Permissions-Policy, HSTS): `.htaccess` bzw. `SECURITY_HEADERS` im Service Worker – beide synchron halten.
- Kein Server-Code, keine Uploads, keine Analyse-/Tracking-Dienste.

## Caching (`.htaccess`)

`/_astro/` und `/ort/` und `/models/*.onnx` immutable (Hash bzw. Version im Namen), `models/manifest.json`, die Seite (`/`, `*.html`) und die Skripte ohne Hash (`coi-serviceworker.js`, `coi-config.js`) `no-cache` (nachfragen, 304 wenn unverändert). Fallstrick (06.11.2026): ohne Regel für die Seite nahm Chrome sie nach eigener Schätzung aus dem Cache (Last-Modified-Heuristik) – nach einem Build noch der alte Stand, der auf gelöschte `_astro`-Bündel verweist. GitHub Pages schickt für HTML selbst `max-age=600` (bis zu 10 min alter Stand möglich, nicht steuerbar). Kompression für Text und wasm; Modelle nicht (Float-Gewichte schrumpfen kaum, kostet nur Server-CPU). Im Browser zusätzlich der Modell-Cache (Cache API, `docs/models.md`).

## Testen (Nov. 2026)

- **Echte GPU:** einen Chrome mit WebGPU headless per Remote-Debugging (CDP) fernsteuern – eigenes temporäres Profil und eigener Port (`--headless=new --remote-debugging-port=<port> --user-data-dir=<temporäres Profil> --ignore-certificate-errors --enable-unsafe-webgpu --window-size=1600,900`), dann `puppeteer-core` mit `browserURL: http://127.0.0.1:<port>`. Beenden per CDP `browser.close()`, nie per Prozessname (ein normal laufender Chrome würde mit beendet). Neues Profil = kalter Shader-Cache. Rechnerspezifische Einzelheiten (Pfade, Hardware) gehören nicht ins Repo.
- Ist die lokale Domain aus einer abgeschotteten Umgebung nicht erreichbar: direkt den Container-Port nehmen (`curl -k https://127.0.0.1:<port>/ -H "Host: upscalr.dev.dasachtegebot.local"`, Port aus `ddev describe`).
- Bilder in die Seite geben: Datei als Base64 per `page.evaluate` → `__upscalr.openFile(new File(…))` (nur mit `?debug`: `globalThis.__upscalr` = `openFile`, `upscale`, `compare`, `upscaler`, `result`). Ergebnis zurück: `result.blob` → Base64.
- Prüfskripte (lokal, nicht im Repo): `run.js` (ein Durchlauf: Bild, Inhalt, Qualität, Faktor → Screenshots, Ergebnisdatei, Panel-Text, Konsole), `run-cpu.js` (`?backend=wasm`), `ui.js` (Abbrechen, „zu groß“, kein Bild, „Über“ + Englisch, Handy-Ansicht, Zoom), `cancel.js`; Referenzvergleich `compare.py` (`docs/models.md`).
- Vor Messungen offene Tabs der Seite schließen (`docs/inference.md` „Fallstricke“).
