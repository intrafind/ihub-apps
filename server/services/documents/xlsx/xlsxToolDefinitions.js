// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Definition of the tool the `xlsx` system skill brings (see
 * `server/systemSkills/xlsx`). Plain data: the handler lives in
 * `xlsxTools.js` and is loaded when the tool runs.
 */

export const CREATE_XLSX_TOOL = {
  id: 'create_xlsx',
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
