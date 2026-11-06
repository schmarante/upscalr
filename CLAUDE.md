# Upscalr – Projektbrief

## Ziel
KI-Upscaler für Fotos, Strichzeichnungen und Illustrationen, der komplett lokal im Browser läuft. Bilder verlassen nie den Rechner.
Keine Lizenzverletzungen, keine Nennung Dritter ohne Freigabe, basiert komplett auf Open-Source

## Stack
- TypeScript + Astro 7 (Vite) + Tailwind 4 wie RINDR, kein UI-Framework; statische Seite, Build nach `dist/` (DDEV-Docroot)
- ONNX Runtime Web (WebGPU, Fallback WASM)
- Inferenz im Web Worker (UI bleibt flüssig)
- Modelle per Cache API zwischenspeichern
- Modelle per eigenem Konverter (Node, ohne PyTorch) aus den veröffentlichten Checkpoints nach ONNX (`npm run models`); die fertigen Dateien liegen als Release dieses Repos (`npm run models:fetch`, Deploy holt sie von dort)

## Modelle (ONNX)
| Inhalt | Modell | Lizenz |
|---|---|---|
| Fotos (schnell) | realesr-general-x4v3, Glättung Mittel/Schwach gemischt mit realesr-general-wdn-x4v3 | BSD-3 |
| Fotos (Qualität) | RealESRGAN_x4plus | BSD-3 |
| Zeichnung / Anime / Lineart | RealESRGAN_x4plus_anime_6B | BSD-3 |
| Freistellen (Hintergrund entfernen) | BiRefNet_lite (fertiger ONNX-Export, umgeschrieben: DeformConv, schmale Knoten) | MIT (Trainingsdaten teils nur nicht-kommerziell, `docs/licenses.md`) |
| Klick-Auswahl (Auswahl bearbeiten) | SAM 2.1 hiera-tiny (fertiger ONNX-Export, Gewichte eingebettet) | Apache 2.0 |
| Schärfen weicher Fotos (Handy) | NAFNet-REDS-width64 (eigener Konverter, nur fp16) | MIT (Trainingsdaten REDS: CC BY 4.0) |
| Gesichter (später) | GFPGAN | Apache 2.0 |

## MVP
- [X] Bild per Drag & Drop / Dateiauswahl (dazu: Einfügen aus der Zwischenablage)
- [X] Modellwahl: Foto (schnell / hoch) / Zeichnung
- [X] Faktor 2x / 4x (2× = 4×-Modell + Flächenmittelung je Kachel)
- [X] Tiling: 256 px Kacheln, ≥ 24 px Überlappung, weich überblendet (keine Nähte – getestet)
- [X] Fortschrittsanzeige (Modell-Download, Kacheln mit Restzeit, Schreiben) + Abbrechen
- [X] Vorher/Nachher-Slider (mit Zoom/Verschieben, ab 300 % pixelscharf)
- [X] Download als hochskaliertes Bild im jeweiligen Original-Dateiformat mit dem Suffix *-upscale.dateiendung (PNG/JPEG/WebP/BMP; AVIF/GIF → PNG mit Hinweis)

## Zusätzlich umgesetzt
- [X] Auswahl bearbeiten (05.11.2026, Wunsch des Nutzers): Klick-Auswahl (Objekt +/−) und Pinsel (Behalten, Wegnehmen, Kante), Rückgängig/Wiederholen, Vorschau in Arbeitsgröße, Übernehmen in voller Größe (`docs/ui.md`)
- [X] Vorschau-Hintergründe für transparente Ergebnisse: Schachbrett, Schwarz, Weiß, Rot, Grün, Blau
- [X] Gegen „wachsige“ Personen (05.11.2026, Wunsch des Nutzers): Glättung Stark | Mittel | Schwach für das schnelle Foto-Modell (Gewichte gemischt, Standard Mittel) und Regler Körnung, der ohne neue Berechnung wirkt (`docs/models.md`, `docs/inference.md`)
- [X] Kantenverfeinerung beim Freistellen: geführter Filter + Vordergrundfarbe (`matte.ts`, Testbild des Nutzers: Saum weg, Strähnen zurück)
- [X] Freistellen: Hintergrund: Behalten | Entfernen, kombinierbar mit 2×/4×, Faktor 1× = nur freistellen (Wunsch des Nutzers, 05.11.2026); JPEG → PNG, Suffix `-cutout` bei 1×
- [X] Weiche Fotos schärfen (06.11.2026, Wunsch des Nutzers): Erkennung beim Öffnen (Kantenbreite, `sharpness.ts`), Vorschlag – Modell-Download (129 MB) nur nach Zustimmung –, Option Schärfen Aus | Schnell | Gründlich; Unschärfe entfernen + auf die echte Auflösung verkleinern, dann hochskalieren; bei 1× Verbessern in Originalgröße (Suffix `-sharpen`) (`docs/inference.md` „Weiche Fotos“, `docs/ui.md`)

## Später
- Freistellen: Kantenverfeinerung als WebGPU-Shader (heute 7,5 s bei 4096² im Worker); „Dunst“ zwischen Locken → echtes Matting-Modell prüfen (Lizenz/Trainingsdaten)
- Gesichtsrekonstruktion (GFPGAN) – Lizenzen der Hilfsmodelle prüfen (`docs/licenses.md`)
- Vektorisieren reiner Strichzeichnungen – nur eigene Umsetzung oder Bibliothek mit freizügiger Lizenz; GPL-Tracer weder verwenden noch nennen (Entscheidung des Nutzers, 05.11.2026)
- Stapelverarbeitung
- Automatische Modellwahl
- Eigene Schreiber für AVIF/GIF (heute PNG-Rückfall)
- Transparente Kanten: Farbe in transparente Pixel ausbluten lassen (sonst dunkler Saum möglich)
- Zwei-Finger-Zoom im Vergleich; Panel auf dem Handy einklappbar

## Grenzen
- Große Bilder nur gekachelt (WebGPU-Speicher); zu wenig Grafikspeicher → Kacheln halbieren bis 64 px
- Ausgabe höchstens 32 767 px Kante / 268 MP (Canvas-Grenzen, `LIMITS` in config.ts)
- Veröffentlichte Seite höchstens 1 GB (GitHub Pages; heute ≈ 790 MB) – große Modelle nur als fp16 (`docs/deployment.md`)

## Offen
- Privat oder kommerziell? (entscheidet Modellauswahl) – vorläufig PolyForm Noncommercial wie RINDR; Trainingsdaten-Frage in `docs/licenses.md`
- Maximale Eingabegröße? (heute nur die Ausgabegrenze oben)
- Muss es ohne WebGPU laufen? – läuft (CPU/WebAssembly mit Threads; schnelles Modell ~5× langsamer, Qualitätsmodell deutlich mehr)
- Endgültiges Logo (heute eigener Platzhalter, `docs/ui.md`)

## Projektregeln
- Antworten an den Nutzer auf Deutsch; Code (Bezeichner, Kommentare, Konsolen-Ausgaben) komplett englisch.
- Konsole still: Info-Ausgaben nur über `debugLog()` aus `src/scripts/log.ts` (nur mit `?debug`); `console.warn/error` bleiben.
- Oberflächentexte nur über `src/i18n/de_de.json` + `en_us.json` (`t()` aus `i18n.ts`), neue Schlüssel immer in beiden Dateien; zwischen Zahl und Einheit U+00A0.
- Icons: je Icon eine SVG-Datei in `src/assets/icons/`, im Code nur `icon(name, klassen)`; Eingaben/Knöpfe mit den Klassen aus `src/scripts/ui-controls.ts`; Fenster im Panel-Stil (`bg-black/60` + Blur).
- **Lizenzen (wichtig):** nichts übernehmen, was Rechte Dritter verletzt; fremden Code nur als Inspiration, eigene Umsetzung. Namen Dritter nur, wo Lizenzen es verlangen oder technisch nötig (Lizenzliste `libraries.ts`, `public/licenses/`, Download-URLs) – nie in der Oberfläche oder als Werbung. Neue Bibliothek/neues Modell: Lizenz der Gewichte prüfen, Nutzer fragen, in `libraries.ts` + `public/licenses/` eintragen. Details: `docs/licenses.md`.
- Grenzen nie auf den Entwicklungsrechner abstimmen: fehlendes Feature / zu schwache Hardware = Hinweis im Panel-Stil (`notice.ts`) oder Rückfall, kein stiller Fehler.
- Bibliotheken aktuell halten (wie RINDR); beim Update der Runtime: Kachelzeiten und Referenzvergleich wiederholen (`docs/inference.md`, `docs/models.md`).
- `public/models/`, `public/ort/`, `.cache/` nicht committen (erzeugt); Testbilder in `tests/` sind ausgenommen.
- **Keine Drittserver (Priorität des Nutzers, 06.11.2026):** Besucher und Deploy ziehen nichts von fremden Servern, nur von unseren GitHub-Repos – der Browser lädt alles von der Seite selbst (CSP `connect-src 'self'`), der Deploy die Modelle aus dem eigenen Release (`docs/deployment.md`). Quellen der Autoren nur beim Umwandeln eines neuen Modell-Stands.
- **Keine persönlichen Details im Repo (Wunsch des Nutzers, 05.11.2026):** keine lokalen Pfade (Benutzerprofile, Home-Verzeichnisse), keine Angaben zum Rechner (Hardware, Betriebssystem-Einrichtung, Netz), keine Konto-/Benutzernamen – weder in Code, Kommentaren, Doku noch Commits. Erlaubt: die lokale Domain `upscalr.dev.dasachtegebot.local`, Name und E-Mail im „Über“-Fenster (`ABOUT` in config.ts) und der Live-Demo-Knopf mit der GitHub-Pages-Adresse in der README (Wunsch des Nutzers). Rechnerspezifisches bleibt lokal.
- **Branches (Wunsch des Nutzers):** gearbeitet wird in `develop`; erst wenn alles passt, `develop` nach `master` übernehmen – das löst den Deploy aus. Committen/Pushen nur auf Ansage.
- **Dokumentation:** Diese Datei ist Übersicht, Regeln und Ziele. Details in `docs/` (Karte unten). Vor Arbeit an einem Bereich die passende Datei lesen; nach Änderungen dort nachtragen (Verhalten, Entscheidungen des Nutzers, verworfene Wege, Fallstricke, Prüfwege).

## Karte der Detail-Dokumentation

| Datei | Inhalt |
|---|---|
| `docs/models.md` | Modelle und Konvertierung – `scripts/models.json`, Konverter (`convert-models.mjs`, `lib/pth-reader.mjs`, `lib/nets.mjs` inkl. NAFNet + fp16-Fallstricke, `lib/onnx-writer.mjs`), fertige ONNX + Umschreiben (`lib/onnx-rewrite.mjs`: DeformConv, schmale Concat/Split), fp32/fp16, Manifest, Modell-Cache (`model-cache.ts`), Prüfung, neues Modell aufnehmen. |
| `docs/inference.md` | Inferenz und Kacheln – Worker (`upscale-worker.ts`, `upscaler.ts`, `types.ts`), Backend-Wahl (eigenes GPU-Gerät), Runtime-Einbindung, Freistellen, weiche Fotos (`sharpness.ts`, `resample.ts`), Kachelplan und Überblenden (`tiling.ts`, Tests), Speicher-Rückfall, Alpha, Messwerte. |
| `docs/image-io.md` | Bildformate – Erkennung, Dekodieren, Schreiben im Originalformat (`image-io.ts`, eigener BMP-Schreiber), Dateiname, Größengrenzen. |
| `docs/ui.md` | Oberfläche – Aufbau (`index.astro`, `app.ts`), Panel, Bild öffnen, Vergleich (`compare.ts`), Hinweise, „Über“, i18n, Icons, Logo, Stil. |
| `docs/deployment.md` | Build und Betrieb – npm-Skripte, DDEV, `dist/`, Unterverzeichnis, GitHub Pages, Cross-Origin-Isolation, CSP/Header, Caching, Testweg mit echter GPU. |
| `docs/licenses.md` | Lizenzen – eigene Lizenz, Pflichten (BSD-3, MIT), wo Namen Dritter stehen dürfen, offene Punkte (kommerziell, GFPGAN, Vektorisieren). |

## Stand (2026-11-06)
- Schärfen weicher Fotos (06.11.2026): eingebaut und in Chrome (WebGPU fp16 + `?backend=wasm`) geprüft – Erkennung, Vorschlag/Zustimmung, Schnell/Gründlich bei 1×/2×/4×. Konsole sauber: eigenes GPU-Gerät für die Runtime (sonst `powerPreference`-Warnung unter Windows bei jeder Sitzung); Icons in durchscheinender Farbe ohne helle Überlappungen (`svg-join.ts`).
- Firefox (05.11.2026): Runtime-Shader „Pad“ wird abgelehnt → Freistell-Modell läuft dort automatisch auf der CPU mit Hinweis – vom Nutzer im echten Firefox bestätigt (Ergebnis kommt). Offen: genaue Shader-Meldung per `?debug` einsammeln, um Firefox ganz auf der GPU zu halten (`docs/inference.md`).
- Freistellen (05.11.2026): Maske 1,1–1,3 s auf dem Testrechner (Desktop-GPU, WebGPU + CPU-Threads für DeformConv), CPU-Weg 2,7 s; gegen das Originalmodell gleich (fp32 Logits ±0,0001).
- MVP komplett, geprüft in Chrome (Desktop-GPU, WebGPU fp16) und mit `?backend=wasm` (CPU): alle drei Modelle, 2×/4×, PNG/JPEG/Alpha, Abbrechen, „zu groß“, Englisch, Handy-Ansicht, Unterverzeichnis-Build. Gekachelt vs. am Stück: 48–59 dB, keine Nähte.
- Tempo: 2000×1333 → 4× (43 MP) in 3,6 s (schnell) bzw. 20,6 s (Qualität).
- `npm test` (Kachel-Logik), `npm run check` (0 Fehler).
- GitHub-Repo verbunden, erster Stand auf `master` und `develop`; Pages-Quelle „GitHub Actions“. Erster Deploy scheiterte an der Branch-Regel der Umgebung `github-pages` (`docs/deployment.md`).
