# Oberfläche und Bedienung

Aufbau der Seite, Panel, Bild öffnen, Vorher/Nachher-Vergleich, Vorschau-Hintergründe, Auswahl bearbeiten (Klick-Auswahl, Pinsel), Hinweise, „Über“, Sprache, Icons, Stil.

## Aufbau (`src/pages/index.astro`, Logik `src/scripts/app.ts`)

- Ganzes Fenster = Bühne `#stage` (Vergleichsansicht). Darüber:
  - **Panel** `#panel` oben links (w-72, `bg-black/60` + Blur wie bei RINDR); unter 768 px Breite unten über die volle Breite (max. 55 % Höhe, scrollt).
  - **Startkarte** `#start` (nur ohne Bild): „Bild hierher ziehen“, Einfügen-Hinweis, Knopf „Bild auswählen“, Formate, Datenschutz-Satz. Auf breiten Fenstern rechts vom Panel zentriert.
  - **Zoom-Werkzeuge** `#view-tools` unten rechts (Einpassen, Originalgröße, Zoom in %), nur mit Bild, nicht auf schmalen Fenstern.
  - Markenzeile unten links mit „Über“ (schmal: „Über“ unten rechts).
- Deutsche Texte werden schon beim Build gerendert (kein Aufblitzen), andere Sprachen per `applyDom()`.

## Panel

Reihenfolge: Logo + Name · Bild (Name, Größe, Format, Knopf „Bild öffnen“) · **Inhalt** Foto | Zeichnung · **Qualität** Schnell | Hoch (nur bei Foto) · **Glättung** Stark | Mittel | Schwach (nur Foto + Schnell; Standard Mittel) · **Körnung** Regler 0–100 % (nur Foto) · **Schärfen** Aus | Schnell | Gründlich (nur Foto) · **Faktor** 1× | 2× | 4× · **Hintergrund** Behalten | Entfernen · Größe vorher → nachher, Schärfen-Zustand (s.u.), Download-Größe der noch fehlenden Modelle bzw. „Modelle bereit (offline)“, ggf. Warnung „zu groß“ bzw. Hinweis „bei 1× nur mit Entfernen“ · Knopf **Hochskalieren** / **Abbrechen** · Fortschritt (Text, Balken amber wie RINDR, Restzeit) · nach dem Ergebnis **Herunterladen** (Link mit `download`-Attribut auf die Blob-URL) + Dateiname + Größe/Dateigröße/Dauer · Rechenwerk (Grafikkarte/Prozessor, 16/32 bit).

- **Einstellungszeilen** (Wunsch des Nutzers, 05.11.2026): jede Einstellung in einer Zeile – links der Name (`text-white/50`, feste Breite), daneben die aktuelle Wahl als Text (`[data-current]`, aus dem `aria-label` des aktiven Knopfs, in `updatePanel()`), rechts die Optionen als **Icons** (Tooltip `title` + `aria-label` aus den Sprachdateien, damit auch ohne Maus/auf dem Handy klar ist, was gewählt ist). Icons: Foto `photo`, Zeichnung `drawing` (Feder), Schnell `fast` (Blitz), Hoch `best` (Edelstein), Glättung `smooth-strong|medium|weak` (glatte → raue Linien), Hintergrund `bg-keep` / `bg-remove` (Person mit durchgezogenem bzw. gestricheltem Rahmen), Schärfen `sharpen-off|fast|thorough`; Faktor bleibt Text (1×/2×/4×). Körnung: Regler in der Zeile, Wert rechts. Optionen je Zeile: `OPTIONS` in `index.astro`. Gilt auch auf dem Handy (spart Höhe im unteren Panel).
- **1×** = nicht hochskalieren, nur freistellen (Inhalt/Qualität abgeblendet, Knopf „Freistellen“); 1× mit „Behalten“ hätte nichts zu tun → Knopf gesperrt mit Hinweis.
- **Glättung** wählt eine der drei Stufen des schnellen Foto-Modells (`CONTENT.photo.fast` in config.ts, `docs/models.md` „blend“) – anderes Modell, also neu hochskalieren. **Körnung** (`docs/inference.md`): Ziehen zeigt den Wert („aus“ bei 0), Loslassen (`change`) schreibt das vorhandene Ergebnis mit der neuen Körnung neu, ohne neu zu rechnen (`regrain()` in app.ts; während „Auswahl bearbeiten“ gesperrt, „Übernehmen“ nimmt den aktuellen Wert). Die Körnung steckt nicht im Einstellungs-Schlüssel des Ergebnisses, sondern in `result.grain`.
- **Schärfen** (06.11.2026, Wunsch des Nutzers: automatisch erkennen, Download nur mit Zustimmung, Variante als Option): für weiche Fotos (Handy) – Ablauf und Erkennung in `docs/inference.md` „Weiche Fotos“. Icons `sharpen-off|fast|thorough` (Fokusrahmen mit Schrägstrich / Blitz / Edelstein – dieselbe Bildsprache wie Schnell/Hoch). Beim Öffnen misst der Worker die Schärfe (`upscaler.analyze`, Bruchteil einer Sekunde); ein weiches Foto bekommt in der Bildzeile „· wirkt weich“. Ist Schärfen an, sagt eine Zeile unter der Größe, ob dieses Foto es bekommt („Weiches Foto – wird vorab geschärft“ / „Foto ist scharf – Schärfen nicht nötig“ / „Schärfe wird geprüft …“, solange gemessen wird – dann ist der Startknopf kurz gesperrt). Bei 1× hat ein weiches Foto mit Schärfen etwas zu tun (Knopf „Schärfen“, Datei `-sharpen`): es wird in Originalgröße verbessert.
- **Zustimmung zum Download** (Wunsch des Nutzers): das Modell (129 MB) wird nur geladen, wenn der Nutzer zugestimmt hat – (a) **Vorschlag** beim ersten weichen Foto (Schärfen aus, noch nie beantwortet): Hinweis „Weiches Foto erkannt“ mit Downloadgröße und den Knöpfen „Schnell schärfen“ / „Gründlich schärfen“ / „Nein, danke“; jede Antwort gilt (`sharpenAsked`), Schließen per × nicht (dann beim nächsten weichen Foto wieder). (b) Wahl im Panel ohne Zustimmung und ohne Modell im Cache: Rückfrage „Modell zum Schärfen laden?“ (Laden / Abbrechen); bis zur Antwort bleibt der Schalter auf dem alten Wert. Zustimmung (`sharpenConsent`) bleibt gespeichert; liegt das Modell schon im Cache, wird nicht gefragt. Das Modell kommt wie alle von dieser Seite (`connect-src 'self'`).
- Einstellungen (Inhalt, Qualität, Glättung, Körnung, Schärfen samt Zustimmung/Vorschlag beantwortet, Faktor, Hintergrund) bleiben je Browser erhalten (`localStorage` `upscalr.settings`, Fehler beim Speichern egal).
- Das Ergebnis bleibt bei geänderten Einstellungen sichtbar; Knopf wird zu „Erneut hochskalieren“, Zusatz „Einstellungen geändert“. Ohne Änderung ist er gesperrt.
- Kein automatischer Start nach dem Öffnen (das Qualitätsmodell ist beim ersten Mal 32 MB Download).
- Segment-Schalter, Knöpfe: Klassen und `segmented()` aus `src/scripts/ui-controls.ts` (einheitlicher Stil; Segment-Knöpfe sind kompakt `h-7 min-w-8`, Inhalt zentriert – Icon oder kurzer Text).

## Bild öffnen

Datei-Dialog (`#file-input`, `accept="image/*"`, Knöpfe mit `data-pick`), **Drag & Drop** aufs Fenster (Overlay `#drop-overlay`; während einer Berechnung gesperrt), **Einfügen** aus der Zwischenablage (Strg+V, erstes Bild). Ein neues Bild verwirft das alte Ergebnis.

Die Datei wird beim Öffnen **einmal komplett in den Speicher gelesen** (`openFile()` → neues `File` aus `arrayBuffer()`), alles Weitere (Vorschau, Dekodieren beim Start, Bearbeiten) arbeitet auf dieser Kopie. Grund (Nutzer-Rückmeldung 05.11.2026, Handy): der Datei-Dialog auf Android liefert einen Verweis, der später unlesbar werden kann – das Bild erschien, beim Start kam „Format nicht lesbar“. Das Dateifeld wird erst nach dem Lesen geleert. Hinweise: `notice.read` (Datei nicht lesbar, z.B. Foto nur in der Cloud), `notice.decode` (Format beim Öffnen nicht lesbar), `notice.decodeRun` (beim Start nicht dekodierbar, obwohl es beim Öffnen ging – meist Speicher); mit `?debug` hängt die Meldung des Browsers an, die Konsole bekommt sie immer (`console.warn`).

## Vergleich (`src/scripts/compare.ts`)

- Beide Bilder liegen übereinander in Ausgabegröße (logische Größe = Ausgabepixel); „Vorher“ wird vom Browser weich vergrößert. Das Ergebnis wird per `clip-path` ab der **Trennlinie** gezeigt (links vorher, rechts nachher, Beschriftungen an der Linie).
- **Trennlinie ziehen** (Griff oder ±8 px um die Linie), mit Fokus auch Pfeiltasten (Shift = größere Schritte). Position in Bildkoordinaten → bleibt beim Zoomen auf demselben Detail. Griff und Beschriftungen sitzen im sichtbaren Teil des Bildes (nicht hinter dem Panel – CSS-Variablen `--handle-y`/`--label-y`).
- **Mausrad** zoomt um den Mauszeiger (2 % … 3200 %), **Ziehen** verschiebt, **Doppelklick** wechselt Einpassen ↔ Originalgröße (1 Ausgabepixel = 1 Gerätepixel). Tasten: `0` Einpassen, `1` Originalgröße, `Esc` bricht eine Berechnung ab.
- Ab 300 % (Gerätepixel je Ausgabepixel) ohne Glättung (`image-rendering: pixelated`) – Pixel beurteilen.
- **Einpassen** in die freie Fläche neben dem Panel (breit) bzw. darüber (schmal) – `compare.insets` aus app.ts. Fensteränderung passt neu ein, solange nicht gezoomt/verschoben wurde.
- Transparentes Ergebnis (freigestellt oder Quelle mit Alpha): **Schachbrett** hinter dem Nachher-Bild (`.checker` in global.css, Feldgröße folgt dem Zoom über `--checker`) – sonst schiene das Vorher-Bild durch den entfernten Hintergrund.
- Ohne Ergebnis: nur „Vorher“ in Zielgröße (Faktor ändern = neue Größe), keine Trennlinie; das leere Ergebnis-`<img>` ist versteckt (zeichnete sonst eine Haarlinie).
- Touch: Ziehen/Verschieben per Pointer Events; Zwei-Finger-Zoom fehlt noch.

- **Während eines neuen Laufs** (06.11.2026, Hinweis des Nutzers: nach einer Freistellung, die nichts fand, war rechts nur Schwarz – das alte, leere Ergebnis vor dem Vorschau-Hintergrund): Liegt schon ein Ergebnis auf dem Bildschirm, zeigt die rechte Seite bis zum neuen Ergebnis das Original weichgezeichnet und abgedunkelt, darüber zieht eine **Glanzkante** diagonal über das Bild (Wunsch des Nutzers: weich, wie ein Glanz, diagonal) – weicher heller Kern, langer sanfter Ausklang dahinter, 30° gedreht, von außen oben links nach außen unten rechts in 2,2 s, dann 1 s Pause (3,2 s Takt; erste Fassung mit schmalem Kern in 1,6 s wirkte wie ein huschender Strich). Umsetzung: `compare.setWorking`, `[data-working]`, CSS `.working-soft` / `.working-shimmer` in `global.css`; die Glanzkante ist ein gedrehtes Quadrat von der Größe der Bilddiagonale (`--sheen`), so überstreicht sie Hoch- und Querformate gleich; Unschärfe per `--soft-blur` immer ein paar Bildschirm-Pixel; bei „Bewegung reduzieren“ ohne Glanz. Abbrechen/Fehler → das alte Ergebnis wieder. Die Farbwahl der Vorschau ist währenddessen ausgeblendet. Beim ersten Lauf (noch kein Ergebnis) bleibt das Bild unverändert. Verworfen: den Schieber während des Laufs ausblenden (Nutzer bot beides an; so sieht man, dass sich etwas tut).

## Vorschau-Hintergründe (05.11.2026, Wunsch des Nutzers)

Bei transparenten Ergebnissen (und beim Bearbeiten) unten rechts sechs Knöpfe: Schachbrett, Schwarz, Weiß, Rot, Grün, Blau – nur die Vorschau, die Datei bleibt transparent. Wahl je Browser gespeichert (`upscalr.bg`). `CompareView.setBackground` (Farben `BACKGROUNDS` in compare.ts; Schachbrett = Klasse `.checker`, Feldgröße folgt dem Zoom). Auf schmalen Fenstern ist die Werkzeugleiste ausgeblendet (offen).

Der Hintergrund liegt auf einer **eigenen Ebene** (`[data-after-bg]`, gleicher Ausschnitt wie das Ergebnis), nicht auf dem `<img>`: sonst blitzte beim Einblenden eines freigestellten Ergebnisses kurz die nackte Farbe auf, bevor das Bild dekodiert war (Nutzer-Rückmeldung 05.11.2026). Ablauf in `setAfter()`: Bild setzen → `decode()` + ein Frame → Ebene weich einblenden (Opacity 0,3 s). Bis dahin scheint im transparenten Teil das Original durch. Ist der Hintergrund schon sichtbar (neue Körnung, übernommene Bearbeitung), bleibt er stehen – kein erneutes Ein-/Ausblenden; ein neuer Lauf (`clearAfter`) blendet neu ein. Gemessen (Chrome, je Frame): 0 Frames mit Hintergrund ohne Bild.

## Auswahl bearbeiten (05.11.2026, Wunsch des Nutzers: „nur Pinsel + Klickauswahl“)

Nach dem Freistellen: Knopf „Auswahl bearbeiten“ (nur wenn das Ergebnis freigestellt ist und die Einstellungen noch passen). Das Panel zeigt dann die Werkzeuge (`[data-edit]`, Logik `src/scripts/editor.ts`, Regeln `src/scripts/selection.ts`):

| Werkzeug | Wirkung |
|---|---|
| **Objekt +** | Klick fügt das Objekt unter dem Mauszeiger hinzu (Klick-Auswahl), Alt+Klick nimmt es heraus |
| **Objekt −** | Klick nimmt das Objekt heraus, Alt+Klick fügt hinzu |
| **Verschieben** | Ziehen verschiebt das Bild (mit jedem Werkzeug: Leertaste halten oder mittlere Maustaste) |
| **Behalten** / **Wegnehmen** | Pinsel: übermalte Bereiche werden ausgewählt / entfernt |
| **Kante** | Pinsel über feinen Kanten (Haare, Fell): dort stärkere Kantenverfeinerung |

- Ausgangspunkt ist die automatische Auswahl; jede Aktion ändert sie, spätere gewinnen. Rückgängig/Wiederholen (Strg+Z, Strg+Umschalt+Z/Strg+Y), Zurücksetzen auf automatisch. Pinselgröße per Regler oder `[` / `]`; Pinsel-Umriss folgt dem Mauszeiger.
- Anzeige: die Vorschau als freigestelltes Bild über dem gewählten Vorschau-Hintergrund; „Entferntes blass zeigen“ (Standard an) lässt Weggenommenes zu 25 % durchscheinen, damit man es wieder anklicken kann.
- Bearbeitet wird in **Arbeitsgröße** (längere Seite höchstens `EDIT.maxSide` = 1536 px): sofortige Grobanzeige beim Malen, danach die verfeinerte Vorschau aus dem Worker (≈ 0,4 s). **Übernehmen** rechnet in voller Ausgabegröße auf dem schon hochskalierten Bild (2048² ≈ 2,3 s) und ersetzt das Ergebnis; **Abbrechen** verwirft.
- **Nicht-destruktiv** (Wunsch des Nutzers, 05.11.2026): Übernehmen merkt sich die Aktionsliste (`EditHistory` aus `editor.history()`, in app.ts `editHistory`). Erneutes „Auswahl bearbeiten“ startet mit dieser Liste auf der automatischen Auswahl – alles Bisherige ist wieder da, Rückgängig geht Schritt für Schritt bis zur Automatik zurück, Zurücksetzen = automatisch. Abbrechen verwirft nur die Änderungen seit dem letzten Übernehmen. Möglich, weil der Worker jedes Übernehmen aus dem unveränderten hochskalierten Bild (`last.out`) und der vollständigen Liste rechnet, nie aus dem vorigen Ergebnis. Die Liste gilt nur für dasselbe Ergebnis (gleiche Arbeitsgröße): ein neuer Lauf oder ein neues Bild verwirft sie; eine neue Körnung nicht.
- Klick-Auswahl lädt beim ersten Bearbeiten ihr Modell (≈ 74 MB, einmalig), analysiert das Bild und macht einen Probe-Klick (Shader übersetzt) – Status „Bereit – klicken oder malen“. Bis dahin funktionieren die Pinsel; scheitert die Klick-Auswahl, bleiben die Pinsel.
- Regeln (`selection.ts`): Objekt = Maske des Klick-Modells (max bzw. min mit Inverser); Striche als kantengeglättete Scheiben entlang des Pfads. Innere von Strichen und angeklickten Objekten (um den Verfeinerungsradius geschrumpft) bleiben nach der Kantenverfeinerung exakt – ohne das zog die Verfeinerung an Bildkanten blasse Umrisse eines entfernten Objekts zurück. Ränder angeklickter Objekte (die Masken des Klick-Modells sind grob, 256²) gehen in die Kanten-Karte. Schrittweises Malen = Neuberechnen aus der Liste (Test).
- Tests: `tests/selection.test.ts`.

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

**Durchscheinende Icons ohne helle Überlappungen** (06.11.2026, Hinweis des Nutzers): Mit einer Farbe mit Alpha (`text-white/35` am Icon oder geerbt, z. B. `text-white/70` der Segment-Knöpfe, `text-white/90` des Panels) malt der Browser jedes Element einzeln – wo sich Rahmen, Linie und Kreis treffen, wird es heller (gemessen im Bild-Icon über Schwarz: 147 statt 89). Zwei Gegenmittel:
- **Einzeln stehende Icons**: Deckkraft mit `opacity-*` statt Farb-Alpha (`text-white opacity-35`) – die ganze Grafik wird erst gemalt, dann abgeschwächt; hilft bei jedem Icon.
- **Geerbte Farbe**: `normalizeSvg` fasst am Ende benachbarte reine Konturen mit gleichen Attributen zu **einem** `<path>` zusammen (`svg-join.ts`; rect/circle/ellipse/line/polyline/polygon als Pfaddaten) – die Kontur eines Pfads wird in einem Zug gemalt, Überlappungen addieren sich nicht. Nicht zusammengefasst: gefüllte Formen (Teilpfade einer Füllung können sich aufheben), Strichelung (Muster begänne anderswo, z. B. Rahmen von `bg-remove`), `transform` und andere Attribute, Formen außerhalb von svg/g. Die Dateien selbst bleiben unverändert (im Vektorprogramm weiter einzeln bearbeitbar). Test: `tests/svg-join.test.ts`.

## Logo

`src/assets/upscalr.svg` (einfarbig, `currentColor`; kleines Quadrat → großer Rahmen mit Pfeil) – eigener Entwurf, **Platzhalter** bis zu einem endgültigen Logo. Daraus: `public/favicon.svg` (weiß auf #0284c7), PNG-Icons, `favicon.ico`, `og-image.png` (1200×630) per ImageMagick (`convert -density … favicon.svg`), `public/upscalr.svg` und `.github/assets/upscalr-white.svg` für die README.

## Stil

Wie RINDR: Hintergrund `neutral-900`, Panels `bg-black/60` + `backdrop-blur-sm`, Text `text-xs text-white/90`, Akzent `sky-400/500`, Fortschritt `amber-400`, dünne Scrollbalken (global.css). Keine Textauswahl in der Oberfläche (`select-none`), außer Hinweistexten, Dateiname, „Über“.
