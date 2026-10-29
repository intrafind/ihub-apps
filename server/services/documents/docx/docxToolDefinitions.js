// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Definition of the tool the `docx` system skill brings (see
 * `server/systemSkills/docx`). Plain data: the handler lives in
 * `docxTools.js` and is loaded when the tool runs.
 */

export const CREATE_DOCX_TOOL = {
  id: 'create_docx',
  name: { en: 'Create Word document', de: 'Word-Dokument erstellen' },
  description: {
    en: String.raw`Create an editable Word document (.docx) on the server and give it to the user as a download. Write the content as Markdown (headings, paragraphs, lists, GFM tables, code, quotes, GitHub alerts like "> [!NOTE]"; "\pagebreak" on its own line starts a new page). Headings become real Word headings, so the user can restyle the document and update the table of contents. The user sees a download card in the chat, so do not paste a link — name the file in your answer instead. Activate the "docx" skill first for guidance.`,
    de: String.raw`Erstellt ein bearbeitbares Word-Dokument (.docx) auf dem Server und stellt es dem Benutzer als Download bereit. Inhalt als Markdown schreiben (Überschriften, Absätze, Listen, GFM-Tabellen, Code, Zitate, GitHub-Hinweise wie "> [!NOTE]"; "\pagebreak" in einer eigenen Zeile beginnt eine neue Seite). Überschriften werden echte Word-Überschriften, sodass der Benutzer das Dokument umformatieren und das Inhaltsverzeichnis aktualisieren kann. Der Benutzer sieht im Chat eine Download-Karte – keinen Link einfügen, stattdessen den Dateinamen nennen. Für Hinweise zuerst den Skill "docx" aktivieren.`
  },
  usesDocumentTemplate: true,
  brandParameters: ['primaryColor', 'font'],
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Download file name without extension, e.g. "project-proposal".'
      },
      title: {
        type: 'string',
        description:
          'Document title: document properties, and printed at the top (or on the cover page).'
      },
      subtitle: { type: 'string', description: 'Optional subtitle under the title.' },
      author: { type: 'string', description: 'Optional author for the properties and cover page.' },
      language: {
        type: 'string',
        description: 'Language code of the document, e.g. "en" or "de" (spell checking, labels).'
      },
      markdown: {
        type: 'string',
        description:
          'The document body in Markdown. Supports GFM tables with column alignment, task lists, nested lists, code blocks, quotes, GitHub alerts ("> [!NOTE]", "[!TIP]", "[!IMPORTANT]", "[!WARNING]", "[!CAUTION]"), horizontal rules, <sub>/<sup>, and images as data:image/png|jpeg URIs.'
      },
      coverPage: {
        type: 'boolean',
        description: 'Start with a cover page (title, subtitle, author, date).'
      },
      toc: {
        type: 'boolean',
        description:
          'Add a table of contents built from the headings (Word updates the page numbers when the file is opened).'
      },
      header: {
        type: 'string',
        description: 'Running header text; placeholders {title}, {page}, {pages}, {date}.'
      },
      footer: { type: 'string', description: 'Running footer text (left); same placeholders.' },
      pageNumbers: { type: 'boolean', description: 'Page numbers in the footer (default true).' },
      pageSize: { type: 'string', enum: ['A4', 'LETTER', 'LEGAL', 'A3', 'A5'] },
      orientation: { type: 'string', enum: ['portrait', 'landscape'] },
      primaryColor: {
        type: 'string',
        description: 'Hex colour for headings, table headers and bullets, e.g. "#0f766e".'
      },
      font: {
        type: 'string',
        description:
          'Body font: "sans" (Calibri), "serif" (Cambria) or a font name installed on the reader\'s computer, e.g. "Arial".'
      }
    },
    required: ['filename', 'title', 'markdown']
  }
};
