# PowerPoint Template Guide

How to build the PowerPoint template (`.potx`) that iHub fills with slides, so decks made in chat look like your own — and what an admin can tell marketing when a deck does not.

iHub never copies the template's sample slides. It reads the **slide master**, the **layouts** and the **theme**, and puts every slide on one of the layouts. Whatever the template should show on every slide therefore has to live in the master and its layouts. See [Document Templates](document-templates.md#powerpoint) for how a template is set up in the admin area.

## Brief for the template designer

Copy this to whoever maintains the template (marketing, design).

1. **One slide master.** Use a single master. Colours, fonts and text sizes are read from the first one.
2. **All design in the master and the layouts.** Logo, edge strips, footer bar, background pictures, the cover photo of the title slide: shapes and backgrounds of the master or a layout. Nothing on sample slides is used.
3. **Provide these layouts**, built from PowerPoint's own layouts (duplicate them, do not draw new ones): *Title Slide*, *Title and Content*, *Section Header*, *Two Content*, *Title Only*, *Blank*.
4. **Use real placeholders.** The title is a **Title** placeholder, text and tables go in **Content** placeholders, the subtitle of the title slide is the **Subtitle** placeholder. Text boxes drawn on a layout are decoration: iHub does not fill them.
5. **Set the look in the placeholders.** Font, size, colour and bullets of the text belong in the master's text styles (levels 1–5) and in the layout's placeholders, not on slides.
6. **Theme colours and fonts.** Define the brand in the theme (Slide Master → Colours, Fonts). Charts use *accent 1–6* in that order, tables use *accent 1* for the header row, KPI cards use *Dark 2* for text, *Light 2* for the card and the first colourful accent for their top rule. Put a brand colour first and avoid grey as *accent 1* if charts should be colourful.
7. **Optional: text slots.** A small text placeholder next to the title that slides can fill — a label above the title, a one-sentence introduction below it, the presenter on the title slide. Name each placeholder (Selection Pane) and tell the admin the names. See [Text slots](#text-slots).
8. **Size 16:9** (13.33 × 7.5 in). Leave room between the title and the content area for slots.
9. **Footer and slide number.** Keep the footer and slide number placeholders on the layouts. On the title slide a footer placeholder with a text (for example the company name) becomes the footer strip.
10. **Fonts.** Use fonts installed on your colleagues' computers; PowerPoint substitutes others.
11. **Save as `.potx`** (or `.pptx`) without macros. Files with macros are refused.

## What iHub reads from the file

| From the file | Used for |
|---|---|
| Slide size | The size of every deck |
| Theme colours and fonts (first master) | Chart colours, table and KPI card colours, the font of charts |
| Master text styles | Bullets, sizes and colours of body text; the size iHub assumes to judge whether text fits |
| Layouts and their placeholders | Where titles, text, tables, charts, pictures and slots go |
| Master and layout shapes, backgrounds | Appear on every slide of that layout, as in PowerPoint |
| Placeholder names, prompt text, position, font size | The description the model reads (see [Text slots](#text-slots)) and the editor's suggestions |

**Not used:** sample slides, custom shows and sections, and the theme of a second master.

## Layouts

iHub chooses a layout for each kind of slide: first by the layout's **type** (the built-in layouts keep theirs), then by its placeholders, then by its **name**. In the editor (**PowerPoint → Layouts for each kind of slide**) an admin can pick another layout where the choice does not fit.

| Slide kind (`layout`) | PowerPoint layout | What iHub puts in it |
|---|---|---|
| `title` | Title Slide / Titelfolie | Title (**Title**), subtitle (**Subtitle**) |
| `section` | Section Header / Abschnitt | Title, the text under it as subtitle |
| `content` | Title and Content / Titel und Inhalt | Title, text, table, chart, picture or KPI cards in the content area |
| `two-column` | Two Content / Zwei Inhalte | Title, two content areas side by side |
| `title-only` | Title Only / Nur Titel | Title; tables, charts and pictures in the free area |
| `blank` | Blank / Leer | Nothing, or content in the free area |

- **Content area:** the first content placeholder of the layout. Make it large and give it the position the text should have.
- **Text** uses the master's bullets and sizes. **Tables** and **charts** are placed in the content area; they are editable PowerPoint objects.
- **Several variants** of a kind are fine (for example *Title and Content* and *Title, Lead and Content*): iHub uses the plain one for ordinary slides and a variant for slides that fill its slots.

## Footer, slide numbers and the title slide strip

- **Footer text and slide numbers** are set in the document template (**Slide footer**, **Slide numbers**) and appear in the layout's footer and slide number placeholders. They do not appear on the title slide.
- **Title slide strip:** if the title layout has a **Footer** placeholder with text in it ("IntraFind Software AG"), every title slide shows that text; the model can replace it per deck (for example "Strategy 2027 · November 2026"). If the layout also has the text as a plain text box under the placeholder, give the placeholder a **white fill** so it covers the box when it is used.

## Text slots

A **text slot** is a text placeholder of a layout that a slide can fill besides its title and content. The model is told which slots the template has, where each one is and how much text fits — so the slots only help if they are placed and sized sensibly.

### How to add a slot in PowerPoint

1. **View → Slide Master**, select the layout (not the master).
2. **Slide Master → Insert Placeholder → Text**, draw the box where the text should be.
3. Give it its look in the placeholder itself: font size, colour, **no bullet**, left aligned. A one-line label is typically 12 pt bold capitals; a lead sentence 16–18 pt.
4. Name it: **Home → Arrange → Selection Pane** (or Alt + F10), double-click the name. A name that says what the text is, such as `Kicker`, `Lead` or `Presenter`.
5. Type a short instruction as the placeholder's text ("One sentence that gives the context"). iHub reads it and shows it to the admin.
6. Repeat for each layout that should have the slot, using the **same name** each time.

Because slides with a slot use a layout that has it, it is simplest to **duplicate** *Title and Content*, *Two Content* and *Title Only*, add the slot placeholders to the copies and name them (for example *Title, Lead and Content*). Give the placeholders room: a label sits between the top edge and the title, a lead between the title and the content area.

### What the admin does

- **Names `Kicker` / `Eyebrow` and `Lead` / `Einleitung`** need no setup: iHub recognises them.
- **Any other name:** in the editor (**PowerPoint → Text slots**) iHub lists "Found in your template": small text placeholders with a name of their own. **Add as slot** takes the name, an id and the template's instruction text. Or add a slot by hand with an id, the placeholder's name, a description for the model and what to do in a layout without it.
- **Checks:** every slot says in which layouts it was found; a slot with no layout shows a warning.

The model then sees, for example:

```
- "kicker": A short label above the slide title. Above the title. Fits one line, about 125 characters.
- "lead": One sentence under the title that gives the context. Below the title. Fits 2 lines, about 175 characters.
```

### What helps the model

- **Small, labelled boxes.** A box that is one line high gets one-line text. The estimate of how much fits comes from the box size and the font size set in the placeholder, so set the size in the placeholder.
- **A description in the template's language.** The placeholder's instruction text, or the admin's description per language.
- **Not a slot:** large boxes, columns, picture or chart placeholders, and placeholders with PowerPoint's default names ("Content Placeholder 3", "Textplatzhalter 5") are never suggested.

## Colours and the look of KPI cards, tables and charts

| Element | Colour |
|---|---|
| Table header row | Accent 1; rows in light tints of it; white text where accent 1 is dark |
| Chart series | Accent 1, 2, 3 … in order, in the theme's body font |
| KPI cards | Light neutral card (*Light 2*), text in *Dark 2*, a rule across the top in the first accent that is not a grey, the figure in that colour when it is readable |
| Text, bullets, titles | From the master's text styles |

If the charts of your decks come out grey, accent 1 of the theme is grey: move a brand colour to the front of the theme's colour scheme.

## Testing a template

1. Upload it under **Admin → Document templates → PowerPoint**. Check the list of layouts per kind and the slots.
2. **Preview** renders a sample presentation with the saved template: look at the title slide, a content slide and a section slide.
3. In a chat with the `pptx` skill, ask for a short deck with a table, a chart and KPI figures, then open it in PowerPoint.
4. Change the template, upload it again, repeat. The model's view of the template follows the file; no restart is needed.

## Problems and causes

| What you see | Cause and remedy |
|---|---|
| The deck has iHub's own design, not the template | The template is not the default, not pinned by the app, or disabled — see [Which template a document gets](document-templates.md#which-template-a-document-gets) |
| Cover photo, logo or strips are missing | They are on a sample slide, not on the master or layout |
| The title slide looks right, other slides do not | Shapes sit on the title layout only; put shared ones on the master |
| Wrong layout for a kind of slide | Choose another under **Layouts for each kind of slide**, or use a built-in layout as the base |
| Text in the wrong place or too large | Placeholders positioned or sized off; set sizes in the master's text styles |
| Charts and tables are grey | Accent 1 is grey |
| A slot is never filled | Its placeholder is not named as declared, or it exists in one layout only: the model's slide needs a layout that has it |
| A slot text appears as the first paragraph | The slide's layout has no such slot and the slot says "first paragraph" |
| Fonts differ from the template | The font is not installed on the computer that opens the file |
| Upload refused | The file has macros (`.potm`) or is not a PowerPoint file |

## Kurzbriefing für das Marketing (Deutsch)

Dieses Briefing können Admins an die Pflege der PowerPoint-Vorlage weitergeben.

1. **Ein Folienmaster.** Farben, Schriften und Textgrößen werden aus dem ersten Master gelesen.
2. **Das ganze Design in Master und Layouts:** Logo, Randstreifen, Fußzeilenleiste, Hintergrundbilder, das Titelbild der Titelfolie. Beispielfolien in der Datei werden nicht verwendet.
3. **Diese Layouts anlegen** (von PowerPoints eigenen Layouts duplizieren): *Titelfolie*, *Titel und Inhalt*, *Abschnitt*, *Zwei Inhalte*, *Nur Titel*, *Leer*.
4. **Echte Platzhalter verwenden:** Titel als **Titel**-Platzhalter, Text und Tabellen in **Inhalts**-Platzhaltern, den Untertitel der Titelfolie als **Untertitel**-Platzhalter. Auf ein Layout gezeichnete Textfelder sind Dekoration und werden nicht gefüllt.
5. **Schrift, Größe, Farbe und Aufzählungszeichen** gehören in die Textformate des Masters (Ebenen 1–5) und in die Platzhalter der Layouts.
6. **Designfarben und Schriftarten im Design (Theme) festlegen.** Diagramme nutzen Akzent 1–6 in dieser Reihenfolge, Tabellenköpfe Akzent 1, KPI-Karten *Dunkel 2*, *Hell 2* und die erste bunte Akzentfarbe. Eine Markenfarbe an den Anfang stellen; Grau nicht als Akzent 1.
7. **Optional: Textfelder.** Kleine Textplatzhalter neben dem Titel, die Folien füllen können: ein Label über dem Titel, ein Einleitungssatz darunter, der Referent auf der Titelfolie. Jeden Platzhalter im **Auswahlbereich** (Alt + F10) benennen, zum Beispiel `Kicker`, `Lead`, `Referent`, den Namen in allen Layouts gleich lassen und dem Admin mitteilen. Schriftgröße, Farbe und „kein Aufzählungszeichen“ im Platzhalter selbst einstellen; als Platzhaltertext eine kurze Anweisung eintragen („Ein Satz, der den Kontext gibt“).
8. **Format 16:9** (33,87 × 19,05 cm). Zwischen Titel und Inhaltsbereich Platz für Textfelder lassen.
9. **Fußzeile und Foliennummer** auf den Layouts behalten. Auf der Titelfolie wird ein Fußzeilen-Platzhalter mit Text (zum Beispiel der Firmenname) zum Fußzeilenstreifen.
10. **Schriften** verwenden, die auf den Rechnern der Kolleginnen und Kollegen installiert sind.
11. **Als `.potx` speichern**, ohne Makros.
