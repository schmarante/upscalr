# Upscalr – Projektbrief

## Ziel
KI-Upscaler für Fotos, Strichzeichnungen und Illustrationen, der komplett lokal im Browser läuft. Bilder verlassen nie den Rechner.
Keine Lizenzverletzungen, keine Nennung Dritter ohne Freigabe, basiert komplett auf Open-Source

## Stack
- TypeScript + Vite, kein Framework
- ONNX Runtime Web (WebGPU, Fallback WASM)
- Inferenz im Web Worker (UI bleibt flüssig)
- Modelle per Cache API zwischenspeichern

## Modelle (ONNX)
| Inhalt | Modell | Lizenz |
|---|---|---|
| Fotos (schnell) | realesr-general-x4v3 | BSD-3 |
| Fotos (Qualität) | RealESRGAN_x4plus | BSD-3 |
| Zeichnung / Anime / Lineart | RealESRGAN_x4plus_anime_6B | BSD-3 |
| Gesichter (später) | GFPGAN | Apache 2.0 |

## MVP
- Bild per Drag & Drop / Dateiauswahl
- Modellwahl: Foto / Zeichnung
- Faktor 2x / 4x
- Tiling: ~256 px Kacheln, 16–32 px Überlappung, weich überblenden (keine Nähte)
- Fortschrittsanzeige
- Vorher/Nachher-Slider
- Download als hochskaliertes Bild im jeweiligen Original-Dateiformat mit dem Suffix *-upscale.dateiendung

## Später
- Gesichtsrekonstruktion (GFPGAN)
- Vektorisieren reiner Strichzeichnungen (Potrace)
- Stapelverarbeitung
- Automatische Modellwahl

## Grenzen
- Große Bilder nur gekachelt (WebGPU-Speicher)

## Offen
- Privat oder kommerziell? (entscheidet Modellauswahl)
- Maximale Eingabegröße?
- Muss es ohne WebGPU laufen?
