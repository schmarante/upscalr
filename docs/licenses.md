# Lizenzen und Fremdmaterial

Eigene Lizenz, Pflichten aus den Lizenzen Dritter, wo Namen Dritter erscheinen dürfen, offene Fragen.

## Eigene Lizenz

PolyForm Noncommercial 1.0.0 (`LICENSE.md`, wie RINDR – vorläufig, die Frage „privat oder kommerziell“ ist offen, CLAUDE.md). Code und Inhalte sind eigene Arbeit; aus RINDR übernommene Bausteine (i18n, Icons-Helfer, Hinweise, About, README-Sync, angepasster Service Worker, einige Icons) stammen vom selben Autor.

## Fremdmaterial, das ausgeliefert wird

| Was | Lizenz | Pflicht | Erfüllt durch |
|---|---|---|---|
| Modell-Gewichte (realesr-general-x4v3, RealESRGAN_x4plus, RealESRGAN_x4plus_anime_6B) – nach ONNX umgewandelt | BSD-3-Clause, © 2021 Xintao Wang | Copyright + Lizenztext in der Doku bei Weitergabe in Binärform; **Namen der Autoren nicht zur Werbung** | `public/licenses/real-esrgan.txt`, „Über“, README |
| ONNX Runtime Web 1.31.1 (JS + wasm) | MIT, © Microsoft; enthält Drittcode (ThirdPartyNotices) | Lizenz- und Copyright-Hinweis | `public/licenses/onnxruntime.txt` (LICENSE + ThirdPartyNotices des Tags v1.31.1) |
| Freistell-Modell BiRefNet_lite (allgemeine Variante), ONNX-Export der onnx-community, von uns umgeschrieben (`docs/models.md`) | MIT, © 2024 ZhengPeng (Code, Gewichte und Export jeweils MIT) | Lizenz- und Copyright-Hinweis | `public/licenses/birefnet.txt`, „Über“, README |
| coi-serviceworker 0.1.7 (verändert) | MIT, © 2021 Guido Zuidhof | Hinweis | Kopfzeile der Datei, `public/licenses/coi-serviceworker.txt` |

Nur zum Bauen (nicht ausgeliefert): Astro, Vite, Tailwind CSS (MIT), TypeScript (Apache-2.0). Der Konverter (`scripts/`) ist eigener Code – keine fremde Implementierung übernommen; die Netzstruktur ist aus den veröffentlichten Gewichten/Layer-Namen nachgebaut.

## Wo Namen Dritter stehen dürfen

- **Nur** wo Lizenzen es verlangen oder es technisch nötig ist: `src/scripts/libraries.ts` („Über“ + README „Built with“), `public/licenses/`, Download-URLs in `scripts/models.json`, Metadaten der ONNX-Dateien (`source`), diese Doku.
- **Nicht** in der Oberfläche (Modelle heißen „Foto · schnell“ usw.), nicht in Werbetexten, nicht als „powered by …“ – BSD-3 Klausel 3 verbietet ausdrücklich, mit den Namen der Autoren für abgeleitete Produkte zu werben.
- Keine Bilder/Inhalte Dritter: Testbilder, Logo und Vorschaubild sind eigene Synthesen.

## Neue Bibliothek / neues Modell

Lizenz prüfen (bei Modellen: die Lizenz der **Gewichte**, nicht nur des Codes, und – soweit bekannt – der Trainingsdaten), Nutzer fragen, dann: Eintrag in `libraries.ts` (+ `about.libs.<id>` in beiden Sprachdateien), Lizenztext nach `public/licenses/` (Feld `notice`), README wird beim Build erzeugt (`sync-readme.mjs`; README danach mit committen).

## Offene Punkte / Risiken

- **Kommerzielle Nutzung:** Die Gewichte stehen unter BSD-3 (kommerziell erlaubt). Die Fotomodelle wurden laut Veröffentlichung auf öffentlichen Forschungsdatensätzen trainiert, deren Bedingungen teils nur Forschung erlauben; ob das auf die Gewichte durchschlägt, ist rechtlich nicht geklärt. Für eine kommerzielle Version vorher prüfen (entscheidet die Modellauswahl – CLAUDE.md „Offen“).
- **Freistellen – Trainingsdaten (geprüft 05.11.2026):** Laut Modellübersicht der Autoren ist die Lite-Variante trainiert auf DIS5K-TR/TEs, DUTS, HRSOD, UHRSD, HRS10K, P3M-10k und einem Personen-Datensatz. **DIS5K** erlaubt laut seinen Nutzungsbedingungen nur „non-commercial use in research or educational purpose“ und verbietet kommerzielle Nutzung „even after copying, editing, processing or any operations of this database“ ohne Erlaubnis der Autoren. P3M-10k: Freigabe unter MIT; Personen-Datensatz: Apache-2.0; DUTS/HRSOD/UHRSD: keine Bedingungen gefunden. Ob die Bedingungen auf die (MIT-lizenzierten) Gewichte durchschlagen, ist rechtlich ungeklärt – für die nicht-kommerzielle Version vertretbar, vor einer kommerziellen Version klären (ggf. bei den DIS-Autoren anfragen) oder Modell tauschen.
- **Freistellen – ausgeschlossen:** eine bekannte Browser-Bibliothek fürs Freistellen steht unter AGPL-3.0 (Copyleft, passt nicht); ein bekanntes Freistell-Modell hat eine eigene, nicht freie Lizenz.
- **Gesichtsrekonstruktion (später):** das Gesichtsmodell selbst ist Apache 2.0, braucht aber Hilfsmodelle (Gesichtserkennung/-segmentierung) mit eigenen Lizenzen – einzeln prüfen.
- **Vektorisieren (später):** keine GPL-Bibliotheken (würden die GPL auf die App ausdehnen, passt nicht zu PolyForm) – und den bekannten GPL-Tracer weder verwenden noch nennen (Entscheidung des Nutzers, 05.11.2026). Nur eigene Umsetzung oder eine Bibliothek mit freizügiger Lizenz.
