/**
 * Definitions of the tools the `pdf` system skill brings (see
 * `server/systemSkills/pdf`). Plain data: the handlers live in `pdfTools.js`
 * and are loaded when a tool runs, so the tool registry can be imported
 * anywhere without pulling in the PDF service.
 */

export const CREATE_PDF_TOOL = {
  id: 'create_pdf',
  name: { en: 'Create PDF', de: 'PDF erstellen' },
  description: {
    en: 'Create a PDF document on the server and give it to the user as a download. Write the content as Markdown (headings, paragraphs, lists, GFM tables, code, quotes; "\\pagebreak" on its own line starts a new page). Use "blocks" only for layouts Markdown cannot express (columns, callouts, SVG charts, QR codes). The user sees a download card in the chat, so do not paste a link — name the file in your answer instead. Activate the "pdf" skill first for layout guidance.',
    de: 'Erstellt ein PDF-Dokument auf dem Server und stellt es dem Benutzer als Download bereit. Inhalt als Markdown schreiben (Überschriften, Absätze, Listen, GFM-Tabellen, Code, Zitate; "\\pagebreak" in einer eigenen Zeile beginnt eine neue Seite). "blocks" nur für Layouts verwenden, die Markdown nicht abbildet (Spalten, Hinweisboxen, SVG-Diagramme, QR-Codes). Der Benutzer sieht im Chat eine Download-Karte – keinen Link einfügen, stattdessen den Dateinamen nennen. Für Layout-Hinweise zuerst den Skill "pdf" aktivieren.'
  },
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Download file name without extension, e.g. "q3-sales-report".'
      },
      title: {
        type: 'string',
        description: 'Document title: PDF metadata, and printed at the top (or on the cover page).'
      },
      subtitle: { type: 'string', description: 'Optional subtitle under the title.' },
      author: { type: 'string', description: 'Optional author for the metadata and cover page.' },
      language: {
        type: 'string',
        description: 'Language code of the document, e.g. "en" or "de" (page labels, metadata).'
      },
      markdown: {
        type: 'string',
        description:
          'The document body in Markdown. Supports GFM tables with column alignment, task lists, nested lists, code blocks, quotes, horizontal rules, <sub>/<sup>, and images as data:image/png|jpeg URIs.'
      },
      // JSON text rather than a schema'd array: the blocks are alternatives
      // (one content key each), which providers with a strict schema mode
      // would turn into "every key required".
      blocks: {
        type: 'string',
        description:
          'Optional JSON array of layout blocks, rendered after the markdown. Each block has one content key: markdown, text, stack, columns, table, ul, ol, image, svg, canvas, qr, toc, pageBreak, callout or box. Example: [{"callout": {"tone": "warning", "title": "Action required", "markdown": "Renew by **31 March**."}}, {"qr": "https://example.com", "fit": 90}]. The full grammar is in the pdf skill reference "references/layout-blocks.md".'
      },
      theme: {
        type: 'string',
        enum: ['default', 'professional', 'minimal'],
        description:
          'default: colourful; professional: serif, restrained greys; minimal: plain, thin rules.'
      },
      primaryColor: {
        type: 'string',
        description: 'Hex colour for headings and accents, e.g. "#0f766e" (brand colour).'
      },
      font: { type: 'string', enum: ['sans', 'serif', 'mono'], description: 'Body font family.' },
      fontSize: { type: 'number', description: 'Body text size in points, 7–16 (default 10.5).' },
      pageSize: { type: 'string', enum: ['A4', 'LETTER', 'LEGAL', 'A3', 'A5'] },
      orientation: { type: 'string', enum: ['portrait', 'landscape'] },
      header: {
        type: 'string',
        description: 'Running header text; placeholders {title}, {page}, {pages}, {date}.'
      },
      footer: { type: 'string', description: 'Running footer text (left); same placeholders.' },
      pageNumbers: { type: 'boolean', description: 'Page numbers in the footer (default true).' },
      coverPage: {
        type: 'boolean',
        description: 'Start with a cover page (title, subtitle, author, date).'
      },
      toc: { type: 'boolean', description: 'Add a table of contents built from the headings.' },
      watermark: {
        type: 'string',
        description: 'Diagonal watermark text on every page, e.g. "DRAFT".'
      },
      margins: {
        type: 'array',
        items: { type: 'number' },
        description:
          'Page margins in points: [left, top, right, bottom] (default [50, 62, 50, 62]).'
      },
      styles: {
        type: 'string',
        description:
          'Optional JSON object of named text styles for blocks, e.g. {"badge": {"bold": true, "color": "#0f766e"}}.'
      },
      images: {
        type: 'string',
        description:
          'Optional JSON object of named images for blocks, e.g. {"logo": "data:image/png;base64,…"}.'
      }
    },
    required: ['filename', 'title']
  }
};

export const PREVIEW_PDF_TOOL = {
  id: 'preview_pdf',
  name: { en: 'Preview PDF page', de: 'PDF-Seite ansehen' },
  description: {
    en: 'Look at one page of a PDF you created with create_pdf, rendered as an image, to check the layout (overflowing tables, awkward page breaks, spacing). Only call it when the layout is uncertain; fix problems by calling create_pdf again.',
    de: 'Zeigt eine Seite eines mit create_pdf erstellten PDFs als Bild, um das Layout zu prüfen (überlaufende Tabellen, ungünstige Seitenumbrüche, Abstände). Nur aufrufen, wenn das Layout unsicher ist; Probleme durch einen erneuten Aufruf von create_pdf beheben.'
  },
  requiresImageInput: true,
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'The file id create_pdf returned.' },
      page: { type: 'integer', description: 'Page number, starting at 1 (default 1).' }
    },
    required: ['file_id']
  }
};
