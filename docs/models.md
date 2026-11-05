# Modelle und Konvertierung

KI-Modelle, eigener Konverter (Checkpoint → ONNX), fertige ONNX-Modelle samt Umschreiben, Varianten, Manifest, Modell-Cache im Browser.

## Überblick

| Id (App) | Inhalt | Netz | Parameter | fp32 | fp16 |
|---|---|---|---|---|---|
| `photo-fast` | Foto, schnell | compact (32 Faltungen + PReLU, Depth-to-Space) | 1,21 M | 4,6 MB | 2,3 MB |
| `photo-quality` | Foto, hohe Qualität | rrdb (23 Blöcke) | 16,70 M | 63,8 MB | 32,0 MB |
| `drawing` | Zeichnung / Anime / Lineart | rrdb (6 Blöcke) | 4,47 M | 17,1 MB | 8,6 MB |

| `cutout` | Freistellen (Hintergrund entfernen) | fertiges ONNX (Swin-T-Encoder + Decoder mit deformierbaren Faltungen), umgeschrieben | – | 172,8 MB | 88,6 MB |

Hochskalierer alle ×4. Herkunft und Lizenzen (BSD-3-Clause bzw. MIT) siehe `docs/licenses.md`. In der Oberfläche heißen die Modelle nur nach Inhalt/Qualität – nie nach dem Upstream-Namen.

## Einzige Quelle: `scripts/models.json`

Je Modell: `id` (Dateiname), `task` (`upscale` | `cutout`), `arch` (`compact` | `rrdb` | `onnx`), `scale`, `source` (Download-URL des Checkpoints), `sha256` (Pflicht – ohne Prüfsumme warnt der Konverter und nennt den Wert), `weights` (Eintrag im Checkpoint, der den State-Dict enthält: `params` oder `params_ema`), `license`.

Welches Modell zu welcher Auswahl gehört: `CONTENT` und `CUTOUT` in `src/scripts/config.ts`.

`arch: "onnx"` (fertige ONNX-Dateien): statt `source`/`sha256` ein Eintrag `variants.{fp32,fp16}.{source,sha256}` (URL mit festem Commit) und `input` (`size`, `mean`, `std` – Eingangsgröße und Normierung, gehen ins Manifest).

## Konverter: `npm run models` (`scripts/convert-models.mjs`)

Nur Node, kein Python, kein PyTorch – läuft in DDEV (`ddev exec npm run models`) und im CI gleich.

1. Checkpoint nach `.cache/weights/` laden (einmal, mit Wiederholungen bei Netzfehlern – GitHub-Release-Downloads lieferten beim ersten Versuch zeitweise 504), Prüfsumme gegen `models.json`.
2. `scripts/lib/pth-reader.mjs` liest den Checkpoint: Zip (gespeichert oder deflate, Zip64) + **abgesicherter Unpickler** – nur die Opcodes eines State-Dicts, nur erlaubte Python-Globals (`collections.OrderedDict`, `torch._utils._rebuild_tensor_v2`, `_rebuild_parameter`, `torch.*Storage`). Alles andere bricht ab: eine Datei kann keinen Code ausführen. Tensoren nur zusammenhängend (row-major), float32/16/64.
3. `scripts/lib/nets.mjs` baut das Netz als ONNX-Graph aus den Namen im State-Dict nach (eigene Umsetzung der veröffentlichten Struktur). Fehlende oder übrige Gewichte = Abbruch („structure differs“).
   - `compact`: `body.N` = Faltung (hat Bias) oder PReLU (nur Gewicht, Steigung je Kanal als `[C,1,1]`); letzte Faltung liefert 3·s² Kanäle → `DepthToSpace` (Modus CRD = PyTorch-PixelShuffle) + nächstnachbar-vergrößerte Eingabe addiert.
   - `rrdb`: `conv_first` → n × RRDB (je 3 Dense-Blöcke à 5 Faltungen mit Concat, LeakyReLU 0,2; Residual ×0,2 – beim 5. Conv in die Gewichte eingerechnet) → `conv_body` + Skip → 2 × (Nearest ×2 + Conv + LeakyReLU) → `conv_hr` → `conv_last`. Nur ×4-Checkpoints (×2 bräuchte Pixel-Unshuffle am Eingang).
   - Nearest-Resize exakt wie im Training: `coordinate_transformation_mode=asymmetric`, `nearest_mode=floor`.
4. `scripts/lib/onnx-writer.mjs` schreibt das ONNX-Protobuf selbst (ModelProto/GraphProto/NodeProto/AttributeProto/TensorProto/ValueInfoProto; IR 8, Opset 17). Ganzzahlige Float-Attribute über `new Float(v)` erzwingen (sonst als INT geschrieben).
5. Zwei Varianten je Modell nach `public/models/`:
   - **fp32** – jedes Backend.
   - **fp16** – Gewichte und Aktivierungen half float, Ein-/Ausgabe bleiben float32 (Cast-Knoten im Graph). Für WebGPU mit `shader-f16`: halbe Download-Größe, halber Speicher. Läuft auch auf der CPU (die Runtime fügt Umwandlungen ein), nur langsamer.
6. Dateiname mit Inhalts-Hash: `<id>-<sha10>.<fp32|fp16>.onnx` → Browser-Cache und Modell-Cache bekommen nie ein veraltetes Modell. Alte `.onnx` werden gelöscht.
7. `public/models/manifest.json`: je Modell `arch`, `scale`, `params`, `variants.{fp32,fp16}.{file,bytes,sha256}`. Die App lädt es bei jedem Start (`no-cache`).

`public/models/` und `.cache/` sind nicht in git (CI erzeugt die Modelle bei jedem Deploy; Checkpoints per `actions/cache`, Schlüssel = Hash von `models.json`).

Optionen: `--only <id>`, `--out <dir>`, `--cache <dir>`. Dauer: Sekunden (ohne Download).

### Ein-/Ausgabe jedes Modells

`input` float32 `[1, 3, H, W]` RGB 0…1 → `output` float32 `[1, 3, 4H, 4W]` (nicht begrenzt – die App klemmt). Dynamische Größen (`height`/`width`), die App nutzt aber immer dieselbe Kachelgröße (`docs/inference.md`).

### Fertige ONNX-Modelle (`arch: "onnx"`)

Werden geladen, geprüft und durch `scripts/lib/onnx-rewrite.mjs` browsertauglich gemacht (eigener Protobuf-Leser, alle übrigen Felder bleiben Byte für Byte):
1. **`fuseDeformConv`:** Exporte ohne DeformConv-Operator schreiben jede deformierbare Faltung als ~120 Einzelknoten aus (int64-Indexrechnung, 4 × GatherND). Die Runtime lässt den int64-Teil auf der CPU, die Index-Tensoren sind riesig – das Freistell-Modell brauchte 6 GB (CPU-Spitze), mehr als WebAssembly adressieren kann (4 GB) → `std::bad_alloc` im Browser, auf WebGPU und CPU. Jeder Block (Namensbereich `<scope>/offset_conv/Conv` + `modulator_conv` + Sigmoid + ×2 als Maske + `regular_conv.weight`) wird durch **einen `DeformConv`-Knoten** (Opset 19, nativer Kernel der Runtime) ersetzt; was die behaltenen Knoten speist (Konstante 2), bleibt. Streng: weicht ein Block ab, bricht die Konvertierung ab. fp16-Modelle bekommen Casts um den Knoten (der Kernel kann nur float32). Opset des Modells 17 → 19 (keine der enthaltenen Operationen ändert dabei ihre Bedeutung – geprüft: keine Reduce-Ops). Ergebnis: 20 Blöcke ersetzt, Datei 214 → 173 MB (die Zerlegung trug große Index-Konstanten), Spitze 6 GB → 2,4 GB, Logits gleich (fp32: max. 0,0001; fp16: 0,02 → Maske 0,19/255).
2. **`limitNodeWidth`:** Ein Shader darf nur begrenzt viele Speicherpuffer binden (WebGPU garantiert 8, die Test-GPU bietet 16); die Runtime macht aus Concat/Split einen Shader mit einem Puffer je Ein-/Ausgang. Das Modell hat Concat mit bis zu 1024 Eingängen und Split mit 32 Ausgängen (Bild in Felder zerlegt) → Fehler „Too many storage buffers in shader“. Ersetzt durch Bäume mit höchstens 7 Ein-/Ausgängen (+1 = 8): 4 Concat + 59 Split. Bitgenau gleich.

Prüfung ohne Browser: `onnxruntime-node` 1.31.1 (gleicher Stand wie im Browser; Python-Wheels für 3.10 enden bei 1.23, die noch keinen DeformConv-Kernel hat) in `.cache/verify/` (nicht in git), Referenz-Logits vom Originalmodell per Python.

Verworfen: das Modell mit PyTorch selbst neu exportieren (hätte den Modell-Code der Autoren ausgeführt – vom Sicherheitsfilter gestoppt; das Umschreiben des fertigen Graphen kommt ohne fremden Code aus).

## Prüfung (Nov. 2026)

- `onnx.checker.check_model(full_check=True)` für alle 6 Dateien ✓.
- Testbild (eigene Synthese: Verläufe, Linien, Kreis, Schrift; 4× bikubisch verkleinert): alle Modelle scharf, PSNR über bikubisch; fp16 vs. fp32 max. 1/255 Abweichung (CPU).
- Browser (WebGPU, fp16, gekachelt) gegen Referenz am Stück (CPU, fp32, gleicher Spiegelrand): schnell 54,7 dB, Qualität 48,0 dB, schnell auf der CPU (wasm, fp32) 59,2 dB – keine Nahtspalten im Fehlerprofil.
- Prüfskripte (lokal, nicht im Repo; Python mit numpy/onnx/onnxruntime/Pillow): `verify.py` (Checker + Testbild), `compare.py` (Browser-Ergebnis gegen Referenz, Fehler je Spalte/Zeile), `montage.py`.

## Modell-Cache im Browser (`src/scripts/model-cache.ts`)

- Cache API, Speicher `upscalr-models-v1` (`MODEL_CACHE` in config.ts – Suffix erhöhen = alle verwerfen).
- `loadModel(url, bytes, onProgress)`: Treffer mit passender Größe → aus dem Cache (auch offline); sonst Download mit Fortschritt (Gesamtgröße aus dem Manifest – `Content-Length` zählt bei komprimierter Übertragung die komprimierten Bytes), dann `cache.put`. Fehlt die Cache API (Privatmodus, Speicher voll): einfach laden.
- `pruneModels(keepUrls)`: nach jedem Laden – alles, was nicht im aktuellen Manifest steht, fliegt raus.
- `cachedModels()`: das Panel zeigt „Modell bereit (offline)“ statt der Download-Größe.
- Läuft im Worker (Cache API gibt es dort auch).

## Neues Modell aufnehmen

1. Lizenz der **Gewichte** prüfen (nicht nur des Codes) und in `docs/licenses.md` festhalten; Nutzer fragen.
2. Eintrag in `scripts/models.json` (Prüfsumme!), bei neuer Struktur Builder in `nets.mjs`.
3. `npm run models`, Ergebnisse gegen eine Referenz prüfen (siehe oben).
4. `CONTENT` in config.ts, Auswahl im Panel (index.astro + `panel.*` in beiden Sprachdateien); Lizenztext nach `public/licenses/`, Eintrag in `src/scripts/libraries.ts` (+ `about.libs.<id>` in beiden Sprachdateien).
