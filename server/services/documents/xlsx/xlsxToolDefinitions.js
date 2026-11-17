// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { filenameParameter, settingsParameter, textEditsParameter } from '../editToolParameters.js';

/**
 * Definition of the tool the `xlsx` system skill brings (see
 * `server/systemSkills/xlsx`). Plain data: the handler lives in
 * `xlsxTools.js` and is loaded when the tool runs.
 */

export const CREATE_XLSX_TOOL = {
  id: 'create_xlsx',
  outputKind: 'workbook',
  name: { en: 'Create Excel workbook', de: 'Excel-Arbeitsmappe erstellen' },
  description: {
    en: 'Create a formatted Excel workbook (.xlsx) on the server, styled in the company\'s corporate design, and give it to the user as a download. Pass "sheets" as a JSON array of worksheets; each sheet has a "name", "columns" (headers with optional format: "currency", "integer", "decimal", "percent", "date", "text", or an Excel numFmt like "#,##0.00 €") and "rows" (numbers, strings, ISO dates "YYYY-MM-DD", or live Excel formulas starting with "=", e.g. "=SUM(B2:B10)"). Row 1 is the column header row; rows[0] is Row 2. The user sees a download card in the chat, so do not paste a link. Activate the "xlsx" skill first for formula and financial-modelling conventions.',
    de: 'Erstellt eine formatierte Excel-Arbeitsmappe (.xlsx) auf dem Server im Unternehmensdesign und stellt sie dem Benutzer als Download bereit. "sheets" als JSON-Array von Tabellenblättern übergeben; jedes Blatt hat "name", "columns" (Spaltenköpfe mit optionalem Format: "currency", "integer", "decimal", "percent", "date", "text" oder einem Excel-Zahlenformat wie "#,##0.00 €") und "rows" (Zahlen, Text, ISO-Datum "YYYY-MM-DD" oder echte Excel-Formeln mit "=", z. B. "=SUM(B2:B10)"). Zeile 1 ist die Kopfzeile; rows[0] ist Zeile 2. Der Benutzer sieht im Chat eine Download-Karte – keinen Link einfügen. Zuerst den Skill "xlsx" aktivieren.'
  },
  usesDocumentTemplate: true,
  brandParameters: ['primaryColor', 'accentColor', 'font'],
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Download file name without extension, e.g. "q3-financial-model".'
      },
      title: {
        type: 'string',
        description: 'Workbook title (document properties).'
      },
      author: {
        type: 'string',
        description: 'Optional author for the document properties.'
      },
      language: {
        type: 'string',
        description: 'Language code of the content, e.g. "en-US" or "de-DE".'
      },
      sheets: {
        type: 'string',
        description:
          'JSON array of worksheets (1–20). Each sheet: {"name":"Summary","columns":[{"header":"Region","align":"left"},{"header":"Q1 (€)","format":"currency"},{"header":"Q2 (€)","format":"currency"},{"header":"Growth","format":"percent"}],"rows":[["EMEA",120000,138000,"=(C2-B2)/B2"],["APAC",85000,102000,"=(C3-B3)/B3"],{"cells":["Total","=SUM(B2:B3)","=SUM(C2:C3)","=(C4-B4)/B4"],"total":true}],"freezeHeader":true,"autoFilter":true}. Row 1 is always the column header row; rows[0] is Row 2. Use English formula names (=SUM, =AVERAGE, =IF, =INDEX, =MATCH, =XLOOKUP).'
      },
      sourceFileId: {
        type: 'string',
        description:
          'Optional id of an .xlsx the user uploaded in this chat (the id attribute of its <content> tag, only when can_use_as_template="true"). Its sheets, styles and defined names are kept; each sheet in "sheets" replaces the sheet of the same name or is appended as a new one. Give the new or changed sheets only.'
      },
      primaryColor: {
        type: 'string',
        description: 'Hex primary brand colour when no company template is used, e.g. "#1e3a8a".'
      },
      accentColor: {
        type: 'string',
        description: 'Hex accent colour when no company template is used, e.g. "#0f766e".'
      },
      font: {
        type: 'string',
        description: 'Font family when no company template is used, e.g. "Calibri" or "Aptos".'
      }
    },
    required: ['filename', 'title', 'sheets']
  }
};

export const EDIT_XLSX_TOOL = {
  id: 'edit_xlsx',
  name: { en: 'Edit Excel workbook', de: 'Excel-Arbeitsmappe bearbeiten' },
  description: {
    en: 'Change an Excel workbook this chat created with create_xlsx instead of building it again: sheet operations ("changes": set cells, append, insert or delete rows, replace, add, delete or rename a sheet), exact text replacements in its texts and formulas ("edits"), new settings ("set"), or a combination. Cells are addressed as in Excel: row 1 is the header row, data starts in row 2. Formulas are not adjusted when rows move: fix references yourself. All changes apply or none. The workbook is built again under the same name. If you do not have its sheets, read it with chat_artifacts_read first. Use create_xlsx only for a new workbook or a rewrite.',
    de: 'Ändert eine Excel-Arbeitsmappe, die dieser Chat mit create_xlsx erstellt hat, statt sie neu zu bauen: Blattoperationen ("changes": Zellen setzen, Zeilen anhängen, einfügen oder löschen, ein Blatt ersetzen, hinzufügen, löschen oder umbenennen), exakte Textersetzungen in Texten und Formeln ("edits"), neue Einstellungen ("set") oder eine Kombination. Zellen werden wie in Excel adressiert: Zeile 1 ist die Kopfzeile, Daten beginnen in Zeile 2. Formeln werden beim Verschieben von Zeilen nicht angepasst: Bezüge selbst korrigieren. Alle Änderungen werden übernommen oder keine. Die Arbeitsmappe wird unter demselben Namen neu erzeugt. Fehlen die Blätter, zuerst mit chat_artifacts_read lesen. create_xlsx nur für eine neue Arbeitsmappe oder eine Neufassung.'
  },
  parameters: {
    type: 'object',
    properties: {
      filename: filenameParameter('budget-2027.xlsx', 'workbook'),
      changes: {
        type: 'array',
        description:
          'Sheet operations, applied in order; "sheet" is a sheet name or its 1-based number: {"op":"setCells","sheet":"Summary","cell":"B3","values":[[125000,"=B3*1.1"]]} (row 1 sets column headers), {"op":"appendRows","sheet":"Summary","rows":[["APAC",90000]]}, {"op":"insertRows","sheet":"Summary","before":4,"rows":[…]}, {"op":"deleteRows","sheet":"Summary","row":5,"count":2}, {"op":"replaceSheet","sheet":"Data","with":{…sheet…}}, {"op":"addSheet","sheet":{…sheet…},"after":"Summary"}, {"op":"deleteSheet","sheet":"Old"}, {"op":"renameSheet","sheet":"Sheet1","to":"Summary"}. Rows and sheets are written as in create_xlsx.',
        items: { type: 'object' }
      },
      edits: textEditsParameter(
        'Replacements in the texts and formulas of the cells, applied after "changes". Each oldText must occur exactly once in all of them.'
      ),
      set: settingsParameter(
        'Settings to change, as in create_xlsx (e.g. {"title": "Budget 2027"}); null removes one. The sheets change through "changes" and "edits".'
      )
    },
    required: ['filename']
  }
};
