// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { filenameParameter, textEditsParameter } from '../editToolParameters.js';

/**
 * Definitions of the tools the `dashboard` system skill brings (see
 * `server/systemSkills/dashboard`). Plain data: the handlers live in
 * `dashboardTools.js` and are loaded when a tool runs.
 *
 * A dashboard is a page of figures the server lays out from a spec, so these
 * tools have a name, a description and a result of their own: what the user
 * sees in the run activity is a dashboard, not a web artifact.
 */

export const CREATE_DASHBOARD_TOOL = {
  id: 'create_dashboard',
  outputKind: 'dashboard',
  name: { en: 'Create dashboard', de: 'Dashboard erstellen' },
  description: {
    en: 'Create a dashboard from figures a tool, an analysis or the user produced: a headline, KPI tiles, ranked bar charts (negative values allowed), line charts, tables, the method and the sources and formulas behind the numbers. It shows in the chat\'s Artifacts panel with a Preview | Code toggle and a download card. Pass the page as a spec in "data"; the server lays it out, so no HTML is written. Activate the "dashboard" skill first: it has the fields and the rules. Every figure is copied from the data of this conversation, never written from memory; "asOf" (the date of the data) and "sources" are required. To change a dashboard that exists, use edit_dashboard.',
    de: 'Erstellt ein Dashboard aus Zahlen, die ein Werkzeug, eine Analyse oder die Person geliefert hat: Überschrift, Kennzahlen-Kacheln, sortierte Balkendiagramme (negative Werte erlaubt), Liniendiagramme, Tabellen, die Methode sowie die Quellen und Formeln hinter den Zahlen. Wird im Artefakte-Panel mit Vorschau-|Code-Umschalter sowie als Download-Karte angezeigt. Die Seite wird als Spezifikation in "data" übergeben; der Server baut sie, es wird kein HTML geschrieben. Zuerst den Skill "dashboard" aktivieren: Er enthält die Felder und die Regeln. Jede Zahl wird aus den Daten dieser Unterhaltung übernommen, nie aus dem Gedächtnis geschrieben; "asOf" (Datum der Daten) und "sources" sind Pflicht. Ein vorhandenes Dashboard mit edit_dashboard ändern.'
  },
  usesDocumentTemplate: true,
  brandParameters: ['primaryColor', 'accentColor', 'font'],
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'File name (with or without .html), e.g. "website-corpus.html". Call the tool again with the same name to replace the dashboard.'
      },
      data: {
        type: 'string',
        description:
          'The dashboard spec as JSON text: {"title","asOf","summary","kpis":[{"label","value"}],"blocks":[{"type":"bars"|"line"|"table"|"text",…}],"method","sources":[{"id","name","description","formula","ref","url"}]}. "title", "asOf" (the date of the data, YYYY-MM-DD) and at least one entry in "sources" are required; the "dashboard" skill lists every field.'
      },
      primaryColor: {
        type: 'string',
        description: 'Optional hex primary brand colour, e.g. "#1e3a8a".'
      },
      accentColor: {
        type: 'string',
        description: 'Optional hex accent colour, e.g. "#0f766e".'
      },
      font: {
        type: 'string',
        description: 'Optional font family.'
      }
    },
    required: ['filename', 'data']
  }
};

export const EDIT_DASHBOARD_TOOL = {
  id: 'edit_dashboard',
  name: { en: 'Edit dashboard', de: 'Dashboard bearbeiten' },
  description: {
    en: 'Change a dashboard this chat already created, by exact text replacements in its spec, instead of writing it again. The spec is the JSON chat_artifacts_read returns for the dashboard. Each "oldText" must occur exactly once in it; it is replaced by "newText". All edits apply or none. The page is laid out again from the changed spec and checked like a new one: "asOf" and "sources" stay required. Use it for every change that touches part of the dashboard (a label, a figure, a block, a source) and to fix what create_dashboard reports. Write a new dashboard with create_dashboard only for a rewrite. A figure you add is copied from the data of the conversation, never written from memory.',
    de: 'Ändert ein Dashboard, das dieser Chat bereits erstellt hat, durch exakte Textersetzungen in seiner Spezifikation, statt es neu zu schreiben. Die Spezifikation ist das JSON, das chat_artifacts_read für das Dashboard liefert. Jeder "oldText" muss genau einmal darin vorkommen; er wird durch "newText" ersetzt. Alle Änderungen werden übernommen oder keine. Die Seite wird aus der geänderten Spezifikation neu gebaut und geprüft wie eine neue: "asOf" und "sources" bleiben Pflicht. Für jede Änderung, die nur einen Teil des Dashboards betrifft (eine Beschriftung, eine Zahl, ein Block, eine Quelle), und für die Probleme, die create_dashboard meldet. Nur für eine Neufassung mit create_dashboard neu erstellen. Eine hinzugefügte Zahl wird aus den Daten der Unterhaltung übernommen, nie aus dem Gedächtnis geschrieben.'
  },
  parameters: {
    type: 'object',
    properties: {
      filename: filenameParameter('website-corpus.html', 'dashboard'),
      edits: textEditsParameter(
        "The replacements in the dashboard's spec JSON, applied in order. Keep each oldText short but unique: a few lines around the change, copied exactly (whitespace and quotes included)."
      )
    },
    required: ['filename', 'edits']
  }
};
