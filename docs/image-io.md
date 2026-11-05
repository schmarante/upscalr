# Bildformate: Lesen, Schreiben, Dateiname

`src/scripts/image-io.ts` (Format, Name, Schreiben), Lesen in `app.ts` / Worker.

## Lesen

- **Erkennung** (`detectMime`): MIME-Typ des Browsers (Aliasse wie `image/jpg`, `image/x-ms-bmp` normalisiert) → sonst Dateiendung → sonst die ersten Bytes (PNG, JPEG, WebP, AVIF, GIF, BMP). Kein `image/*` → Hinweis `notice.notImage`.
- **Dekodieren** macht der Browser: `createImageBitmap(file)` – EXIF-Ausrichtung wird angewendet (`imageOrientation: from-image`), Farbraum nach sRGB umgerechnet. Was der Browser nicht lesen kann (z.B. HEIC in Chrome, TIFF) → Hinweis `notice.decode`.
- Für den Auftrag wird das Bitmap neu erzeugt und an den Worker **übertragen** (kein Kopieren); der Worker zeichnet es in eine OffscreenCanvas und liest RGBA.
- Bekannte Grenzen: animierte GIF/WebP/APNG → nur das erste Bild; 16-bit-PNG → 8 bit; eingebettete Farbprofile → in sRGB umgerechnet (großer Farbraum geht verloren); Metadaten (EXIF, Kamera) fallen beim Schreiben weg.

## Schreiben – im Originalformat

`encodeImage` (läuft im Worker):

| Format | Weg |
|---|---|
| PNG, JPEG, WebP | `OffscreenCanvas.convertToBlob` – JPEG/WebP mit Qualität `ENCODE` (config.ts, 0,95) |
| BMP | eigener Schreiber `encodeBmp`: 24 bit, mit Transparenz 32 bit (BITMAPV4HEADER mit Kanalmasken), Zeilen von oben nach unten, in Blöcken à 16 MB (kein riesiger Einzelpuffer) |
| AVIF, GIF, ICO, … | kann der Canvas nicht schreiben → er liefert laut Spezifikation **PNG** (verlustfrei); die Seite erkennt das an `blob.type` und zeigt `notice.formatFallback` |

Safari schreibt kein WebP über den Canvas → dort ebenso PNG mit Hinweis. Eigene Schreiber für AVIF/GIF: später (siehe CLAUDE.md „Später“).

**Freistellen braucht Transparenz:** kann das Originalformat keine (JPEG – `ALPHA_FORMATS` in image-io.ts), wird PNG geschrieben, Hinweis `notice.alphaFormat`. BMP kann (eigener 32-bit-Schreiber), WebP und PNG sowieso.

## Dateiname (`resultName`)

`<name>-upscale.<endung>`, bei 1× (nur freigestellt) `<name>-cutout.<endung>` – die Endung des Originals bleibt in ihrer Schreibweise (`IMG_1.JPG` → `IMG_1-upscale.JPG`, `.jpeg` bleibt `.jpeg`). Musste in ein anderes Format geschrieben werden (s.o.), kommt dessen Endung (`bild.avif` → `bild-upscale.png`). Ohne Namen (Zwischenablage) heißt die Quelle `image.<ext>`.

## Größengrenzen

`LIMITS` in config.ts: Ausgabe höchstens 32 767 px Kantenlänge und 16384² ≈ 268 MP (2D-Canvas-Grenzen aktueller Browser). Größer → Warnung im Panel (`panel.tooLarge`), Knopf gesperrt – statt eines Fehlers am Ende. Scheitert trotzdem etwas (Speicher), kommen `too-large` (Ausgabepuffer nicht anlegbar) bzw. `encode` (Canvas/Kodieren) mit dem Rat, 2× zu wählen. Wie groß Eingaben sein dürfen, ist offen (CLAUDE.md).
