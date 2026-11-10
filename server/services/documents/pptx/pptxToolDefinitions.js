// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Definition of the tool the `pptx` system skill brings (see
 * `server/systemSkills/pptx`). Plain data: the handler lives in
 * `pptxTools.js` and is loaded when the tool runs.
 */

export const FRAME_PPTX_TOOL = {
  id: 'frame_pptx',
  outputKind: 'presentation',
  name: { en: 'Apply presentation frame', de: 'Präsentationsrahmen anwenden' },
  description: {
    en: 'Put the company\'s slide frame on a PowerPoint deck the user uploaded, and give it back as a download: the first slide becomes the cover (background picture, logo, title, date), every other slide gets the frame (strips along the edges, logo). The deck\'s own content (text, pictures, charts, tables, notes) is kept as it is. Pass the id of the uploaded .pptx (the id attribute of its <content> tag, only when can_use_as_template="true"). Use it to move an existing deck into the corporate design; use create_pptx to write a new deck. Only works when the document template has a slide frame.',
    de: 'Legt den Folienrahmen des Unternehmens auf eine hochgeladene PowerPoint-Datei und stellt sie als Download bereit: Die erste Folie wird zur Titelfolie (Hintergrundbild, Logo, Titel, Datum), alle anderen erhalten den Rahmen (Streifen an den Rändern, Logo). Der Inhalt der Datei (Text, Bilder, Diagramme, Tabellen, Notizen) bleibt unverändert. Die ID der hochgeladenen .pptx übergeben (das id-Attribut ihres <content>-Tags, nur bei can_use_as_template="true"). Zum Überführen einer vorhandenen Präsentation ins Unternehmensdesign; für neue Präsentationen create_pptx verwenden. Funktioniert nur, wenn die Dokumentvorlage einen Folienrahmen hat.'
  },
  usesDocumentTemplate: true,
  brandParameters: [],
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description:
          'Id of the .pptx the user uploaded in this chat (the id attribute of its <content> tag, only when can_use_as_template="true").'
      },
      filename: {
        type: 'string',
        description: 'Download file name without extension, e.g. "q3-board-review-branded".'
      },
      cover: {
        type: 'boolean',
        description:
          'Make the first slide the cover (default true). Pass false when the first slide is a content slide.'
      },
      coverTitle: {
        type: 'string',
        description: 'Cover title. Default: the title of the first slide.'
      },
      coverDate: {
        type: 'string',
        description:
          'Cover date or subtitle, one short line. Default: the subtitle of the first slide.'
      },
      coverFooter: {
        type: 'string',
        description:
          'Text of the cover\'s footer strip. Default: the template\'s, else "title · date".'
      }
    },
    required: ['fileId']
  }
};

export const CREATE_PPTX_TOOL = {
  id: 'create_pptx',
  outputKind: 'presentation',
  name: { en: 'Create presentation', de: 'Präsentation erstellen' },
  description: {
    en: 'Create a PowerPoint presentation (.pptx) on the server, on the company\'s slide template, and give it to the user as a download. Pass the slides as a JSON array in "slides"; each slide has a layout ("title", "section", "content", "two-column", "title-only", "blank"), a "title" and content: "text" (Markdown bullets), "table", "chart" (native, editable) or "image", plus optional speaker "notes". Example: [{"layout":"title","title":"Q3 Review","subtitle":"Board meeting"},{"title":"Highlights","text":"- Revenue +12 %\\n- 40 new customers"},{"title":"Revenue","chart":{"type":"column","categories":["Q1","Q2"],"series":[{"name":"2026","values":[1.2,1.4]}]}}]. The user sees a download card in the chat, so do not paste a link. Activate the "pptx" skill first for the full slide grammar and design rules.',
    de: 'Erstellt eine PowerPoint-Präsentation (.pptx) auf dem Server, auf der Folienvorlage des Unternehmens, und stellt sie dem Benutzer als Download bereit. Die Folien als JSON-Array in "slides" übergeben; jede Folie hat ein Layout ("title", "section", "content", "two-column", "title-only", "blank"), einen "title" und Inhalt: "text" (Markdown-Aufzählung), "table", "chart" (nativ, bearbeitbar) oder "image", dazu optional Sprechernotizen "notes". Beispiel: [{"layout":"title","title":"Q3-Bericht","subtitle":"Vorstandssitzung"},{"title":"Highlights","text":"- Umsatz +12 %\\n- 40 Neukunden"}]. Der Benutzer sieht im Chat eine Download-Karte – keinen Link einfügen. Für die vollständige Folien-Grammatik und Gestaltungsregeln zuerst den Skill "pptx" aktivieren.'
  },
  usesDocumentTemplate: true,
  brandParameters: ['primaryColor'],
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Download file name without extension, e.g. "q3-board-review".'
      },
      title: { type: 'string', description: 'Presentation title (document properties).' },
      author: { type: 'string', description: 'Optional author for the document properties.' },
      language: {
        type: 'string',
        description: 'Language code of the content, e.g. "en-US" or "de-DE" (spell checking).'
      },
      // JSON text rather than a schema'd array: the slide fields are
      // alternatives, which providers with a strict schema mode would turn
      // into "every key required".
      slides: {
        type: 'string',
        description:
          'JSON array of slides (at most 60). Slide fields: layout, title, subtitle (title and section slides), text (Markdown: bullets "- ", numbered "1. ", **bold**), metrics (1–4 KPI callout cards: [{"value":"+18 %","label":"Revenue YoY","note":"vs. +11 % plan"}]), table {"header":[…],"rows":[[…]],"align":["left","right"]}, chart {"type":"column|bar|line|pie|doughnut|area","categories":[…],"series":[{"name":…,"values":[…]}],"stacked":false,"showValues":true,"numberFormat":"#,##0"}, image {"data":"data:image/png;base64,…","caption":…}, left/right for two-column slides (each {"heading","text","metrics","table","chart","image"}), notes (speaker notes). Text plus a table, chart or image on one slide are placed side by side; metrics plus text/visual place KPI cards across the top.'
      },
      footer: {
        type: 'string',
        description:
          'Footer text on every slide but the title slide (if the template has a footer).'
      },
      slideNumbers: { type: 'boolean', description: 'Slide numbers (default true).' },
      aspectRatio: {
        type: 'string',
        enum: ['16:9', '4:3'],
        description: 'Slide format when no company slide template is used (default 16:9).'
      },
      primaryColor: {
        type: 'string',
        description: 'Hex accent colour when no company template is used, e.g. "#0f766e".'
      },
      templateFileId: {
        type: 'string',
        description:
          'Optional id of a .pptx the user uploaded in this chat (the id attribute of its <content> tag, only when can_use_as_template="true"). Its slide master, layouts and theme are used for the new slides.'
      },
      templateMode: {
        type: 'string',
        enum: ['styles_only', 'append'],
        description:
          'How to use templateFileId. "styles_only" (default) builds the new slides on the deck\'s master and layouts and drops its existing slides; "append" keeps its existing slides and adds the new ones after them.'
      }
    },
    required: ['filename', 'title', 'slides']
  }
};
