# Oberfläche und Bedienung

Aufbau der Seite, Panel, Bild öffnen, Vorher/Nachher-Vergleich, Hinweise, „Über“, Sprache, Icons, Stil.

## Aufbau (`src/pages/index.astro`, Logik `src/scripts/app.ts`)

- Ganzes Fenster = Bühne `#stage` (Vergleichsansicht). Darüber:
  - **Panel** `#panel` oben links (w-72, `bg-black/60` + Blur wie bei RINDR); unter 768 px Breite unten über die volle Breite (max. 55 % Höhe, scrollt).
  - **Startkarte** `#start` (nur ohne Bild): „Bild hierher ziehen“, Einfügen-Hinweis, Knopf „Bild auswählen“, Formate, Datenschutz-Satz. Auf breiten Fenstern rechts vom Panel zentriert.
  - **Zoom-Werkzeuge** `#view-tools` unten rechts (Einpassen, Originalgröße, Zoom in %), nur mit Bild, nicht auf schmalen Fenstern.
  - Markenzeile unten links mit „Über“ (schmal: „Über“ unten rechts).
- Deutsche Texte werden schon beim Build gerendert (kein Aufblitzen), andere Sprachen per `applyDom()`.

## Panel

Reihenfolge: Logo + Name · Bild (Name, Größe, Format, Knopf „Bild öffnen“) · **Inhalt** Foto | Zeichnung · **Qualität** Schnell | Hoch (nur bei Foto) · **Faktor** 1× | 2× | 4× · **Hintergrund** Behalten | Entfernen · Größe vorher → nachher, Download-Größe der noch fehlenden Modelle bzw. „Modelle bereit (offline)“, ggf. Warnung „zu groß“ bzw. Hinweis „bei 1× nur mit Entfernen“ · Knopf **Hochskalieren** / **Abbrechen** · Fortschritt (Text, Balken amber wie RINDR, Restzeit) · nach dem Ergebnis **Herunterladen** (Link mit `download`-Attribut auf die Blob-URL) + Dateiname + Größe/Dateigröße/Dauer · Rechenwerk (Grafikkarte/Prozessor, 16/32 bit).

- **1×** = nicht hochskalieren, nur freistellen (Inhalt/Qualität abgeblendet, Knopf „Freistellen“); 1× mit „Behalten“ hätte nichts zu tun → Knopf gesperrt mit Hinweis.
- Einstellungen (Inhalt, Qualität, Faktor, Hintergrund) bleiben je Browser erhalten (`localStorage` `upscalr.settings`, Fehler beim Speichern egal).
- Das Ergebnis bleibt bei geänderten Einstellungen sichtbar; Knopf wird zu „Erneut hochskalieren“, Zusatz „Einstellungen geändert“. Ohne Änderung ist er gesperrt.
- Kein automatischer Start nach dem Öffnen (das Qualitätsmodell ist beim ersten Mal 32 MB Download).
- Segment-Schalter, Knöpfe: Klassen und `segmented()` aus `src/scripts/ui-controls.ts` (einheitlicher Stil).

## Bild öffnen

Datei-Dialog (`#file-input`, `accept="image/*"`, Knöpfe mit `data-pick`), **Drag & Drop** aufs Fenster (Overlay `#drop-overlay`; während einer Berechnung gesperrt), **Einfügen** aus der Zwischenablage (Strg+V, erstes Bild). Ein neues Bild verwirft das alte Ergebnis.

## Vergleich (`src/scripts/compare.ts`)

- Beide Bilder liegen übereinander in Ausgabegröße (logische Größe = Ausgabepixel); „Vorher“ wird vom Browser weich vergrößert. Das Ergebnis wird per `clip-path` ab der **Trennlinie** gezeigt (links vorher, rechts nachher, Beschriftungen an der Linie).
- **Trennlinie ziehen** (Griff oder ±8 px um die Linie), mit Fokus auch Pfeiltasten (Shift = größere Schritte). Position in Bildkoordinaten → bleibt beim Zoomen auf demselben Detail. Griff und Beschriftungen sitzen im sichtbaren Teil des Bildes (nicht hinter dem Panel – CSS-Variablen `--handle-y`/`--label-y`).
- **Mausrad** zoomt um den Mauszeiger (2 % … 3200 %), **Ziehen** verschiebt, **Doppelklick** wechselt Einpassen ↔ Originalgröße (1 Ausgabepixel = 1 Gerätepixel). Tasten: `0` Einpassen, `1` Originalgröße, `Esc` bricht eine Berechnung ab.
- Ab 300 % (Gerätepixel je Ausgabepixel) ohne Glättung (`image-rendering: pixelated`) – Pixel beurteilen.
- **Einpassen** in die freie Fläche neben dem Panel (breit) bzw. darüber (schmal) – `compare.insets` aus app.ts. Fensteränderung passt neu ein, solange nicht gezoomt/verschoben wurde.
- Transparentes Ergebnis (freigestellt oder Quelle mit Alpha): **Schachbrett** hinter dem Nachher-Bild (`.checker` in global.css, Feldgröße folgt dem Zoom über `--checker`) – sonst schiene das Vorher-Bild durch den entfernten Hintergrund.
- Ohne Ergebnis: nur „Vorher“ in Zielgröße (Faktor ändern = neue Größe), keine Trennlinie; das leere Ergebnis-`<img>` ist versteckt (zeichnete sonst eine Haarlinie).
- Touch: Ziehen/Verschieben per Pointer Events; Zwei-Finger-Zoom fehlt noch.

## Hinweise (`src/scripts/notice.ts`, aus RINDR)

Karten oben mittig im Panel-Stil, gleiche `id` ersetzt die Karte. Verwendet: kein WebGPU (`backend`), Modelle fehlen (`models`), kein Bild / nicht lesbar (`open`), Format-Rückfall (`format`), kleinere Kacheln (`tile`), Fehler (`error`; mit `?debug` die technische Meldung dazu).

## „Über“ (`src/scripts/about.ts`)

`<dialog>` mit Name, Beschreibung, Autor/E-Mail (`ABOUT` in config.ts), Version (`__APP_VERSION__`: package.json major.minor + Commit-Anzahl, „-dev“ bei ungespeicherten Änderungen), Rechenwerk (Backend · Genauigkeit · Adapter), **Sprachwahl**, Dankeszeile, Bibliotheken/Modelle mit Link und Lizenz – die Lizenz-Plakette verlinkt den Lizenztext in `public/licenses/`. Liste aus `src/scripts/libraries.ts` (auch für die README).

## Sprache / i18n (`src/scripts/i18n.ts`, aus RINDR)

- Alle Oberflächentexte aus `src/i18n/de_de.json` (Referenz) und `en_us.json` – neue Schlüssel immer in beiden Dateien (Gleichstand: derzeit 90 Schlüssel). Code, Kommentare, Konsole: Englisch.
- `t('bereich.schlüssel', { platzhalter })`, Mehrzahl `{ one, other }`, `data-i18n` / `data-i18n-html` (nur `<b> <strong> <i> <em> <br>`) / `data-i18n-title` / `data-i18n-aria`.
- Sprachwahl: `?lang=` > gespeicherte Wahl (`upscalr.lang`) > Browsersprache > Deutsch. Umschalten im „Über“-Fenster (`upscalr:language`-Ereignis → Panel neu beschriftet).
- Zwischen Zahl und Einheit (px, MB, s, min, bit) ein geschütztes Leerzeichen U+00A0 – in den Sprachdateien und im Code (`NBSP` in app.ts).
- Der Worker übersetzt nichts (Fehlercodes).

## Icons (`src/scripts/icons.ts`, aus RINDR)

Je Icon eine SVG-Datei in `src/assets/icons/` (16×16-viewBox, Farbe = Textfarbe), im Code nur `icon(name, klassen)` – keine SVG-Strings im Code. Aus RINDR übernommen: close, cross, warning, info, download, open, check, reset; neu: image, fit, actual-size, upscale. Ausnahme: Pfeile im Griff der Trennlinie (inline in index.astro).

## Logo

`src/assets/upscalr.svg` (einfarbig, `currentColor`; kleines Quadrat → großer Rahmen mit Pfeil) – eigener Entwurf, **Platzhalter** bis zu einem endgültigen Logo. Daraus: `public/favicon.svg` (weiß auf #0284c7), PNG-Icons, `favicon.ico`, `og-image.png` (1200×630) per ImageMagick (`convert -density … favicon.svg`), `public/upscalr.svg` und `.github/assets/upscalr-white.svg` für die README.

## Stil

Wie RINDR: Hintergrund `neutral-900`, Panels `bg-black/60` + `backdrop-blur-sm`, Text `text-xs text-white/90`, Akzent `sky-400/500`, Fortschritt `amber-400`, dünne Scrollbalken (global.css). Keine Textauswahl in der Oberfläche (`select-none`), außer Hinweistexten, Dateiname, „Über“.
