// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { filenameParameter, settingsParameter, textEditsParameter } from '../editToolParameters.js';

/**
 * Definition of the tool the `docx` system skill brings (see
 * `server/systemSkills/docx`). Plain data: the handler lives in
 * `docxTools.js` and is loaded when the tool runs.
 */

export const CREATE_DOCX_TOOL = {
  id: 'create_docx',
  outputKind: 'document',
  name: { en: 'Create Word document', de: 'Word-Dokument erstellen' },
  description: {
    en: String.raw`Create an editable Word document (.docx) on the server and give it to the user as a download. Write the content as Markdown (headings, paragraphs, lists, GFM tables, code, quotes, GitHub alerts like "> [!NOTE]"; "\pagebreak" on its own line starts a new page). Headings become real Word headings, so the user can restyle the document and update the table of contents. The user sees a download card in the chat, so do not paste a link — name the file in your answer instead. Activate the "docx" skill first for guidance.`,
    de: String.raw`Erstellt ein bearbeitbares Word-Dokument (.docx) auf dem Server und stellt es dem Benutzer als Download bereit. Inhalt als Markdown schreiben (Überschriften, Absätze, Listen, GFM-Tabellen, Code, Zitate, GitHub-Hinweise wie "> [!NOTE]"; "\pagebreak" in einer eigenen Zeile beginnt eine neue Seite). Überschriften werden echte Word-Überschriften, sodass der Benutzer das Dokument umformatieren und das Inhaltsverzeichnis aktualisieren kann. Der Benutzer sieht im Chat eine Download-Karte – keinen Link einfügen, stattdessen den Dateinamen nennen. Für Hinweise zuerst den Skill "docx" aktivieren.`
  },
  usesDocumentTemplate: true,
  templateGuide: 'docx',
  brandParameters: ['primaryColor', 'accentColor', 'font'],
  fieldParameters: ['fields'],
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
      date: {
        type: 'string',
        description:
          'Optional date for the cover page and the {{date}} placeholder; {{year}} is its year (defaults to today).'
      },
      showTitle: {
        type: 'boolean',
        description:
          'Print the title block at the top of page 1 when there is no cover page (default true; with a table of contents it appears above the contents). Set to false for letters where the recipient block and subject line open the document.'
      },
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
          'Add a table of contents built from the headings (Word updates the page numbers when the file is opened; other viewers show it empty). A template with a {{toc}} placeholder shows one where it wants it unless you set this to false; leave it unset to follow the template.'
      },
      fields: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Values of the template\'s own fields, as {"name": "value"}. The fields a template has, and which of them are required, are listed in this tool\'s description. Ask the user for a required value you do not know; do not invent one. For a Word file the user uploaded (templateFileId): values for its {{placeholders}} that are not built in (the tool reports the ones left without a value).'
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
      accentColor: {
        type: 'string',
        description: 'Hex colour for secondary accents, e.g. "#0284c7".'
      },
      templateFileId: {
        type: 'string',
        description:
          'Optional id of a .docx the user uploaded in this chat (the id attribute of its <content> tag, only when can_use_as_template="true"). Its styles, headers/footers and page setup are used for the new document. Its own {{placeholders}} that are not built in ({{project}} …) are filled from "fields".'
      },
      templateMode: {
        type: 'string',
        enum: ['styles_only', 'fill_placeholders', 'append'],
        description:
          'How to use templateFileId. "styles_only" (default when the file has no {{content}} marker) keeps styles, headers/footers and page setup and drops the old body text; "fill_placeholders" fills {{title}}, {{date}}, … and inserts the content at {{content}}; "append" adds the content after the old body.'
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

export const EDIT_DOCX_TOOL = {
  id: 'edit_docx',
  name: { en: 'Edit Word document', de: 'Word-Dokument bearbeiten' },
  description: {
    en: 'Change a Word document this chat created with create_docx instead of writing it again: exact text replacements in its Markdown ("edits"), new settings ("set": title, subtitle, author, date, header, footer, toc, coverPage, pageNumbers, fields, …), or both. Each oldText must occur exactly once; all edits apply or none. The document is rendered again under the same name, in the same template. If you do not have its Markdown, read it with chat_artifacts_read first. Use create_docx only for a new document or a rewrite.',
    de: 'Ändert ein Word-Dokument, das dieser Chat mit create_docx erstellt hat, statt es neu zu schreiben: exakte Textersetzungen im Markdown ("edits"), neue Einstellungen ("set": title, subtitle, author, date, header, footer, toc, coverPage, pageNumbers, fields, …) oder beides. Jeder oldText muss genau einmal vorkommen; alle Änderungen werden übernommen oder keine. Das Dokument wird unter demselben Namen in derselben Vorlage neu erzeugt. Fehlt das Markdown, zuerst mit chat_artifacts_read lesen. create_docx nur für ein neues Dokument oder eine Neufassung.'
  },
  parameters: {
    type: 'object',
    properties: {
      filename: filenameParameter('quarterly-report.docx', 'document'),
      edits: textEditsParameter(
        'Replacements in the Markdown, applied in order. Keep each oldText short but unique: a heading, a sentence or a table row, copied exactly.'
      ),
      set: settingsParameter(
        'Settings to change, as in create_docx (e.g. {"title": "Q3 Report", "toc": true}); null removes one. The Markdown changes through "edits".'
      )
    },
    required: ['filename']
  }
};
