# Inferenz und Kacheln

Worker, Backend-Wahl (WebGPU / CPU), Inferenz-Runtime, Freistellen, Kachelung mit nahtloser Überblendung, Speicher-Rückfall, Alpha-Kanal.

## Dateien

| Datei | Aufgabe |
|---|---|
| `src/scripts/upscaler.ts` | Seitenseite: startet den Worker, kennt das Backend (`info`, `onBackend`), schickt Aufträge (`run` → `{ promise, cancel }`), lädt das Manifest (`loadManifest`), `publicUrl()` für Pfade unter `public/` (beachtet `BASE_URL`). |
| `src/scripts/upscale-worker.ts` | Worker: Backend, Sitzung, Kacheln, Alpha, Kodieren. |
| `src/scripts/tiling.ts` | Reine Funktionen (ohne DOM): Kachelplan, Rampen, Spiegelrand, Netz-Eingabe, 2×-Reduktion, Überblenden. |
| `src/scripts/grain.ts` | Körnung (rein, ohne DOM), Test `tests/grain.test.ts`. |
| `src/scripts/types.ts` | Nachrichten Seite ↔ Worker, Manifest-Typen. |
| `tests/tiling.test.ts` | `npm test` (Node, ohne Browser). |

## Nachrichten

Seite → Worker: `init { ortBase, debug, forceCpu, forceFp32, verbose }`, `run { id, bitmap (übertragen), factor (1/2/4), upscale (Modell + scale, null bei 1×), cutout (Modell + size/mean/std, null = Hintergrund behalten), mime, tile, quality, grain (0…1), keepUrls }`, `cancel { id }`, `grain { id, amount }` (letztes Ergebnis mit anderer Körnung neu schreiben), `edit-apply { …, grain }`.
Worker → Seite: `ready { backend, precision, adapter }` (auch erneut, wenn WebGPU ausfällt), `progress { phase: download | prepare | cutout | tiles | alpha | encode }`, `notice { code: 'tile-reduced', tileSize }`, `done { blob, width, height, mime, alpha, ms }`, `error { code, message }`.
Fehlercodes → Texte `notice.error.<code>` (download, model, gpu-memory, too-large, encode, cancelled, unknown). Der Worker übersetzt nichts.

Aufträge laufen nacheinander (Promise-Kette im Worker). Abbrechen wirkt zwischen zwei Kacheln (die laufende endet noch).

## Backend

- **WebGPU**, wenn `navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })` einen Adapter liefert; **fp16-Modell**, wenn der Adapter `shader-f16` hat, sonst fp32. Die Seite wählt die Modelldatei nach `info.precision`.
- **`powerPreference` nicht in Chrome unter Windows** (06.11.2026, Wunsch des Nutzers: Konsole sauber): Chrome ignoriert die Option dort (die Windows-Einstellung entscheidet über die Grafikkarte) und meldet bei jedem Aufruf „The powerPreference option is currently ignored when calling requestAdapter() on Windows“. Der Worker fragt dort ohne Optionen; erkannt an `navigator.userAgentData.platform === 'Windows'` (gibt es nur in Chromium, auch im Worker). Firefox und andere Systeme bekommen die Option weiter (Laptops mit zwei Grafikchips). Prüfweg: Seite im Windows-Chrome laden, Konsole (auch CDP `Log.entryAdded`) ohne die Meldung; Gegenprobe mit dem alten Aufruf in einem Worker zeigt sie.
- Sonst **CPU** (WebAssembly, fp32). Threads = Kerne (max. 16), nur mit Cross-Origin-Isolation (`crossOriginIsolated`; Header aus `.htaccess` bzw. Service Worker – `docs/deployment.md`) – **auch mit WebGPU**: Knoten, die auf der CPU bleiben (DeformConv des Freistell-Modells), liefen mit 1 Thread 5,4 s je Maske, mit allen Kernen 1,1 s; das Hochskalieren wird dadurch nicht langsamer.
- Scheitert die WebGPU-Sitzung, schaltet der Worker dauerhaft auf CPU und meldet ein neues `ready` (Hinweis `notice.noWebgpu`).
- **Shader abgelehnt → nur dieses Modell auf die CPU** (05.11.2026): Firefox 159 (Windows) lehnt beim Freistell-Modell einen Shader der Runtime ab – „Failed to create a WebGPU compute pipeline: ShaderModule with 'Pad' label is invalid“ (die Hochskalierer enthalten keinen Pad-Knoten). Erkennt der Worker so einen Fehler (`isShaderError`: ShaderModule/compute pipeline/WGSL), baut er die Sitzung dieses Modells auf der CPU neu, wiederholt den Lauf und meldet `notice.cpuFallback` (Text je Aufgabe); das Modell bleibt für weitere Bilder auf der CPU. Speicherfehler (Kacheln halbieren) und Shader-Fehler werden getrennt behandelt. Das fp16-Modell läuft dann auf der CPU (mit Umwandlungen): Maske ≈ 5,7 s statt 1,5 s, kein zusätzlicher Download.
- **Diagnose:** mit `?debug` meldet der Worker abgelehnte Shader samt Fehlermeldung und Quelltextzeilen (`watchShaders`: umhüllt `GPUDevice.createShaderModule`, liest `getCompilationInfo()`) – in der Konsole („WebGPU shader … rejected“) und unter `__upscalr.gpuErrors`. Test-Schalter `?debug&failgpu=cutout|upscale` simuliert den abgelehnten Shader beim ersten WebGPU-Lauf (geprüft in Chrome: beide Rückfälle laufen durch).
- Firefox headless bietet kein WebGPU (auch nicht mit erzwungenen Einstellungen) – den echten Fehler gibt es nur im normalen Fenster; Fernsteuerung von Firefox über WebDriver BiDi (Chrome über CDP).
- Test-Schalter: **`?backend=wasm`** erzwingt die CPU, **`?precision=fp32`** die 32-bit-Modelle, **`?ortlog=verbose`** (mit `?debug`) protokolliert, welcher Knoten auf welchem Backend läuft (`Node(s) placed on [CPUExecutionProvider]`).

## Inferenz-Runtime (onnxruntime-web 1.31)

- Import `onnxruntime-web/webgpu` = nativer WebGPU-EP (nicht der ältere JSEP-Weg); derselbe wasm-Build enthält den CPU-EP. Der native EP kennt `PRelu` (die Tabelle in `docs/webgpu-operators.md` des Pakets beschreibt noch JSEP und listet es nicht – geprüft: keine Knoten auf der CPU, Warnungen mit `?debug` an).
- Vite-Alias in `astro.config.mjs` auf `dist/ort.webgpu.min.mjs` (die Variante **ohne** eingebetteten Loader): wasm + Loader kommen aus `public/ort/<version>/` (`ort.env.wasm.wasmPaths`). Grund: die Hilfs-Threads der Runtime laden ihr eigenes Modul als Worker – beim gebündelten Loader wäre das unser Worker-Chunk.
- `scripts/copy-ort.mjs` (vor `dev` und `build`) kopiert `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` (~28 MB, komprimiert ~¼) nach `public/ort/<version>/`, löscht alte Versionen. Versionsordner = Cache-Bruch bei Updates (`__ORT_VERSION__` per Vite-`define`). `public/ort/` ist nicht in git.
- Sitzungen: `graphOptimizationLevel: 'all'`; Log der Runtime nur mit `?ortlog=verbose` (sonst nur Fehler – ihre Warnungen fluteten die Konsole und verdeckten die eigenen Meldungen). Je Aufgabe eine Sitzung (`upscale`, `cutout`), sie bleibt für weitere Bilder mit demselben Modell bestehen; Modellwechsel → `release()`.

## Freistellen (`cutoutMask` im Worker)

- Ablauf je Bild: Quelle lesen → **Maske** (wenn „Hintergrund: Entfernen“) → Hochskalieren (wenn Faktor > 1) → Alpha der Quelle (falls vorhanden) → Maske in den Alpha-Kanal **multiplizieren** → schreiben.
- Maske: das ganze Bild auf 1024×1024 gestaucht (wie im Training, Seitenverhältnis egal), ImageNet-Normierung (`input` aus dem Manifest), ein Lauf, Ausgabe = Logits → Sigmoid → 0…255.
- Auf Ausgabegröße per Canvas weich vergrößert (`scaleIntoAlpha`, gleiche Streifen-Technik wie der Alpha-Kanal).
- 1×: kein Hochskalieren, nur Maske auf die Originalpixel.
- Danach **Kantenverfeinerung** (`src/scripts/matte.ts`, Phase `refine`), siehe unten.

## Freistellen – Kanten (`matte.ts`, 05.11.2026)

Anlass: Testbild des Nutzers (Porträt, blonde Locken vor rosa Wand, 1024 → 4×): Kanten unsauber – die 1024er-Maske 4× vergrößert ist weich und folgt keiner Strähne, abstehende Haare fehlen, in halbtransparenten Pixeln steckt die Wandfarbe (heller/rosa Saum auf neuem Hintergrund).

1. **Geführter Filter mit Farbführung** (He/Sun/Tang): Maske gefiltert mit dem hochskalierten Bild als Führung → Kanten folgen den echten Bildkanten, Strähnen und abstehende Haare kommen zurück. Radius r = 4 × (Ausgabe / Maskenauflösung) (bei 4096 aus 1024: 16 px), ε = 1e-4.
2. **Vordergrundfarbe per Blur-Fusion** (Forte/Pitié, zwei Durchgänge, Radien 22 × bzw. 1,5 × Vergrößerung): halbtransparente Pixel bekommen die geschätzte Haarfarbe statt der Wandfarbe → kein Saum.

Umsetzung: Box-Filter mit laufenden Summen (zeilenweise, auch die Spalten – kein Springen im Speicher), Verarbeitung in Streifen mit dem nötigen Rand und seitlich auf den Bereich um halbtransparente Pixel zugeschnitten (außerhalb ist das Ergebnis exakt gleich der Eingabe) → wenige Dutzend MB statt > 1 GB. Gegen den Python-Prototyp geprüft (Alpha max. 0,5 Stufen), `tests/matte.test.ts` prüft Streifen/Zuschnitt = am Stück. Tempo 4096²: Node 4,3 s (zuerst 14 s, dann Spalten-Summen 9 s, Zuschnitt 5,5 s), im Browser-Worker 7,5 s – nächster Schritt: als WebGPU-Shader.

Ergebnis beim Testbild: Außenkonturen deutlich besser (kein Saum, Strähnen, abstehende Haare); **offen:** „Dunst“ in Lücken zwischen Locken, wo schon das Modell unsicher ist – das löst nur ein echtes Matting-Modell (Kandidat: trimap-basiertes Matting, Lizenz/Trainingsdaten prüfen).

Verworfen: Alpha aus lokaler Vorder-/Hintergrundfarbe projizieren (Trimap aus der Maske, Farben per gewichteter Unschärfe) – im Schatten zwischen den Locken ist die Wand dunkler als geschätzt, große Flächen wurden fälschlich deckend.

## Auswahl bearbeiten im Worker (05.11.2026)

- Nach jedem Freistellen behält der Worker `last`: Quellpixel, das Ergebnis **vor** dem Anwenden der Maske (hochskaliertes RGB, Alpha = Quell-Alpha oder 255) und die automatische Maske – Vorschau und Übernehmen müssen nie neu hochskalieren.
- `edit-start`: Arbeitsgröße (längere Seite ≤ `EDIT.maxSide`), Bild + automatische Maske in dieser Größe zurück (`edit-ready`); danach im Hintergrund die Klick-Auswahl: Encoder + Decoder laden, Bild (auf 1024² gestaucht, ImageNet-Normierung) analysieren, ein Probe-Klick übersetzt die Decoder-Shader (sonst dauerte der erste echte Klick 15,8 s statt 46 ms), dann `edit-select-ready`.
- `edit-click`: ein Punkt (Bruchteil des Bildes × 1024), leere Box-Eingabe `[1, 0, 4]`, von den drei Kandidaten der mit dem besten Qualitätswert; Logits 256² bilinear auf Arbeitsgröße, steile Sigmoid → Maske 0…255.
- `edit-refine`: Arbeitsbild + Grobmaske → `refineCutout` mit Kanten-Karte und exakten Inneren → Vorschau (`edit-preview`).
- `edit-apply`: Grobmaske auf Ausgabegröße, Karten ebenso (`scaleGray`), `refineCutout` auf dem hochskalierten Bild, schreiben → `done` wie ein normales Ergebnis.
- `refineCutout` (matte.ts) kann jetzt: Kanten-Karte = zweiter, stärkerer geführter Filter (doppelter Radius, ε/4) nur im Ausschnitt der Kanten-Karte, eingeblendet nach ihrem Wert; `keep`/`remove` als Unter-/Obergrenze des Alphas.
- Messwerte (Desktop-GPU, warm): Analyse 89 ms, Probe-Klick 63 ms, Klick → Maske 46–60 ms, Vorschau 0,35–0,43 s (1024²), Übernehmen bei 2048² 2,3 s.

## Kachelung (`tiling.ts`, Werte in `TILING`, config.ts)

- Bild zuerst virtuell um `pad` = 8 px **gespiegelt** (`mirror`, ohne Kantenpixel zu doppeln; winzige Bilder klemmen) – wie im Training sieht das Netz am Bildrand Inhalt statt Null-Padding.
- **Kachelplan** (`starts`/`planTiles`): Kacheln `size` = 256 px (bei kleinen Bildern Bildgröße), möglichst wenige mit mindestens `overlap` = 24 px Überlappung, **gleichmäßig verteilt** (alle Überlappungen gleich ±1 px; vorher: feste Schrittweite + letzte Kachel an den Rand geschoben → teils fast doppelte Kachel). Alle Kacheln gleich groß → gleiche Tensorform → Shader einmal kompiliert.
- **Netz-Eingabe** (`tileInput`): RGBA-Bytes → float32 NCHW 0…1.
- **2×** (`reduceOutput`): die Modelle können nur ×4; für 2× wird jede Kachel 2×2 gemittelt (Flächenfilter, exakt für ganzzahlige Verhältnisse) – vor dem Überblenden, also ohne ein 4×-Gesamtbild im Speicher.
- **Überblenden in zwei Schritten** (Fallstrick, durch den Nahtentest gefunden):
  1. Kacheln einer Reihe nebeneinander in ein **Band** (RGB-Bytes, Ausgabebreite × Kachelhöhe): in der Überlappung mit der linken Kachel lineare Rampe `(k + 0,5) / Überlappung` – 0 am eigenen Rand (wenig Kontext), 1 genau dort, wo die linke Kachel endet (`ramp`, `blendTileIntoBand`).
  2. Fertiges Band genauso entlang y in die Ausgabe (`blendBand`).
  Direkt jede Kachel mit dem Produkt beider Rampen in die Ausgabe („over“) lässt in den Ecken der Überlappung eine Stufe: der Anteil des linken Nachbarn im oberen Band wird nie ausgeblendet (bis zu ¼ des Helligkeitsunterschieds zweier Kacheln). Getrennt je Richtung ist jede Mischung eindimensional und überall stetig.
  Speicher: Ausgabe RGBA + ein Band (bei 4× und 8000 px Breite ≈ 25 MB) – keine Float-Puffer in Ausgabegröße.
- Fortschritt je Kachel; die Seite schätzt die Restzeit aus der mittleren Kachelzeit.

## Körnung (`grain.ts`, 05.11.2026)

Wunsch des Nutzers: Personen wirkten nach dem Hochskalieren zu glatt („wachsig“). Neben der Glättungsstufe des schnellen Modells (`docs/models.md`, `blend`) gibt es einen Regler **Körnung** 0–100 % (nur bei Foto; bei 1× ohne Wirkung), der nach dem Hochskalieren feines Rauschen in Ausgabegröße hinzufügt – eigene Umsetzung:
- Rauschen je Pixel aus einem Hash der Position (32-bit-Finalizer) → gleiche Stärke = gleiches Bild, unabhängig von der Reihenfolge; näherungsweise normalverteilt (Summe von vier Gleichverteilten).
- 3×3-Binomial-Weichzeichnung → Korn ≈ 1,5 px statt Einzelpixel-Grieseln (Nachbar-Korrelation ≈ 0,67, Test), Verstärkung 8/3 hält die Standardabweichung.
- Gleicher Wert auf R, G, B (kein Farbrauschen); Gewicht nach Helligkeit 0,3 + 2,8·L·(1 − L): Mitteltöne voll, Schwarz/Weiß 30 % (weiße Hintergründe bleiben sauber). Alpha unverändert.
- Stärke: 100 % = Standardabweichung 8 Stufen (`GRAIN_SIGMA`; zuerst 12 – 80 % war am Porträt deutlich zu grob).

Der Worker behält das letzte Ergebnis **ohne Körnung** (`final`: RGBA in Ausgabegröße, fertiges Alpha, Format); die Körnung kommt auf eine Kopie direkt vor dem Kodieren (`encodeFinal`). Ein anderer Regler-Wert schreibt also nur neu (`grain`-Nachricht): 3200×1844 in ≈ 0,15 s statt neu hochzuskalieren. `final` wird beim Start eines neuen Laufs verworfen (Speicher) – zusammen mit `last`/`edit`; die Seite merkt sich das (`workerHasResult`): danach (z.B. abgebrochener neuer Lauf) gilt ein Ergebnis mit anderer Körnung als veraltet → „Erneut hochskalieren“.

## Speicher-Rückfall

Wirft eine Kachel auf WebGPU einen Fehler (meist: Grafikspeicher), halbiert der Worker die Kachelgröße (bis `minSize` = 64), baut die Sitzung neu und fängt von vorn an (Hinweis `notice.tileReduced`). Reste des Fehlversuchs schaden nicht: jedes Pixel einer Rampe wurde im neuen Durchgang schon von der Vorgänger-Kachel geschrieben. Unter 64 px → Fehler `gpu-memory`. Grenzen nicht auf den Entwicklungsrechner abstimmen.

## Alpha-Kanal

Hat das Bild Transparenz (ein Alpha < 255), wird der Alpha-Kanal aus dem Originalbild per Canvas weich vergrößert (`imageSmoothingQuality: 'high'`) – in Streifen von ~32 MB mit 4 Quellzeilen Rand (gleiches Ergebnis wie am Stück, ohne zweites Bild in Ausgabegröße). Das Netz sieht nur RGB; voll transparente Pixel kommen als Schwarz an (Canvas speichert vormultipliziert) – an weichen Kanten möglich: dunkler Saum (offen).

## Messwerte (Testrechner mit Desktop-GPU, Chrome 156, WebGPU fp16, Nov. 2026)

| Bild | Modell | Kacheln | Zeit gesamt |
|---|---|---|---|
| 600×400 → 4× | schnell | 6 | 0,8–1,0 s (≈40 ms/Kachel) |
| 600×400 → 4× | Qualität | 6 | ≈3 s (inkl. erstem Kompilieren) |
| 2000×1333 → 4× (43 MP, JPEG) | schnell | 54 | 3,6 s |
| 2000×1333 → 4× (43 MP, JPEG) | Qualität | 54 | 20,6 s (≈356 ms/Kachel) |
| 600×400 → 4× | schnell, **CPU** (wasm, Threads) | 6 | 4,3 s (≈0,5 s/Kachel) |
| 800×600 freistellen (1×) | Freistellen fp16, WebGPU + CPU-Threads | – | Maske 1,1–1,3 s (warm), erster Lauf ~3 s |
| 800×600 freistellen + 4× | Freistellen + schnell | 12 | ≈2 s warm |
| 800×600 freistellen (1×) | Freistellen, **CPU** (wasm, Threads) | – | Maske 2,7 s |
| 800×461 → 4× (Porträt) | schnell, Glättung Stark / Mittel / Schwach | – | 0,7 / 0,6 / 0,5 s (warm) |
| Körnung ändern, 3200×1844 | – | – | ≈ 80 ms Körnung, ≈ 0,15 s mit JPEG-Schreiben |

Erster Besuch mit leerem Shader-Cache des Browsers: das erste Bild dauerte 18,6 s statt 0,8 s (Kompilieren der Shader); danach aus dem Cache. Modell-Sitzung anlegen (Qualität, fp16): einige Sekunden.

## Fallstricke beim Testen

- Neues Chrome-Profil = kalter Shader-Cache → erste Zeiten nicht mit späteren vergleichen.
- Bricht ein puppeteer-Skript ab, bleibt sein Tab offen und rechnet weiter – vor Messungen offene Tabs der Seite schließen (sonst falsche Zeiten / Hänger).
- Testweg siehe `docs/deployment.md` „Testen“.
