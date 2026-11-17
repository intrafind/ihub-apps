// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Definition of the tool the `web-artifacts` system skill brings (see
 * `server/systemSkills/web-artifacts`). Plain data: the handler lives in
 * `webArtifactTools.js` and is loaded when the tool runs.
 */

export const CREATE_WEB_ARTIFACT_TOOL = {
  id: 'create_web_artifact',
  outputKind: 'webArtifact',
  name: { en: 'Create interactive web artifact', de: 'Interaktives Web-Artefakt erstellen' },
  description: {
    en: 'Create a self-contained interactive HTML micro-app (.html) — dashboards, calculators, data explorers, simulators, clickable UI prototypes, HTML5 Canvas/generative visuals — or a standalone vector graphic (.svg). Rendered live in the chat\'s Artifacts panel with a Preview | Code toggle and a download card. Inline all CSS and JS in one file; libraries only from the allowlisted CDNs. Activate the "web-artifacts" skill first for design and sandbox rules. To change an artifact that exists, use edit_web_artifact instead of writing it again. For a dashboard of figures from tools or from the user, activate the "dashboard" skill instead and pass preset "dashboard" with its JSON "data": the server lays out the page, so no HTML is written.',
    de: 'Erstellt eine eigenständige interaktive HTML-Anwendung (.html) – Dashboards, Rechner, Daten-Explorer, Simulatoren, klickbare UI-Prototypen, HTML5-Canvas-Visualisierungen – oder eine Vektorgrafik (.svg). Wird direkt im Artefakte-Panel mit Vorschau-|Code-Umschalter sowie als Download-Karte angezeigt. Gesamtes CSS und JS in einer Datei einbetten; Bibliotheken nur von den freigegebenen CDNs. Zuerst den Skill "web-artifacts" aktivieren. Ein vorhandenes Artefakt mit edit_web_artifact ändern, statt es neu zu schreiben. Für ein Dashboard aus Zahlen von Werkzeugen oder von der Person stattdessen den Skill "dashboard" aktivieren und preset "dashboard" mit dem JSON "data" übergeben: Der Server baut die Seite, es wird kein HTML geschrieben.'
  },
  usesDocumentTemplate: true,
  brandParameters: ['primaryColor', 'accentColor', 'font'],
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'File name (with or without .html / .svg extension), e.g. "roi-calculator.html" or "system-architecture.svg".'
      },
      format: {
        type: 'string',
        enum: ['html', 'svg'],
        description:
          'Artifact type: "html" for interactive single-file web apps/dashboards/visualizations (default), "svg" for standalone vector graphics.'
      },
      title: {
        type: 'string',
        description: 'Optional title of the artifact.'
      },
      content: {
        type: 'string',
        description:
          'Complete, self-contained HTML document (<!DOCTYPE html>… with inline <style> and <script>) or <svg xmlns="http://www.w3.org/2000/svg" viewBox="…"> markup. Omit it when "preset" is used.'
      },
      preset: {
        type: 'string',
        enum: ['dashboard'],
        description:
          'Optional ready-made page the server lays out from "data" instead of "content": "dashboard" (KPI tiles, ranked bar charts, line charts, tables, method and sources). Activate the "dashboard" skill first for the spec.'
      },
      data: {
        type: 'string',
        description:
          'With "preset": the page\'s spec as JSON text. For "dashboard": {"title","summary","kpis":[{"label","value"}],"blocks":[{"type":"bars"|"line"|"table"|"text",…}],"method","sources"}; the "dashboard" skill lists every field.'
      },
      primaryColor: {
        type: 'string',
        description:
          'Optional hex primary brand colour exposed as CSS custom property --brand-primary, e.g. "#1e3a8a".'
      },
      accentColor: {
        type: 'string',
        description:
          'Optional hex accent colour exposed as CSS custom property --brand-accent, e.g. "#0f766e".'
      },
      font: {
        type: 'string',
        description: 'Optional font family exposed as CSS custom property --brand-font.'
      }
    },
    required: ['filename']
  }
};

export const EDIT_WEB_ARTIFACT_TOOL = {
  id: 'edit_web_artifact',
  name: { en: 'Edit web artifact', de: 'Web-Artefakt bearbeiten' },
  description: {
    en: 'Change an interactive HTML or SVG artifact this chat already created, by exact text replacements, instead of writing the whole file again. Each "oldText" must occur exactly once in the current file; it is replaced by "newText". All edits apply or none. The result is the file\'s new version in the Artifacts panel, checked like a new one. Use it to fix the problems create_web_artifact reports and for every change the user asks for that touches part of the file. Write a new file with create_web_artifact only for a rewrite or a file that was cut off.',
    de: 'Ändert ein interaktives HTML- oder SVG-Artefakt, das dieser Chat bereits erstellt hat, durch exakte Textersetzungen, statt die ganze Datei neu zu schreiben. Jeder "oldText" muss genau einmal in der aktuellen Datei vorkommen; er wird durch "newText" ersetzt. Alle Änderungen werden übernommen oder keine. Das Ergebnis ist die neue Version der Datei im Artefakte-Panel, geprüft wie eine neue. Für die Probleme, die create_web_artifact meldet, und für jede Änderung, die nur einen Teil der Datei betrifft. Nur für eine Neufassung oder eine abgeschnittene Datei mit create_web_artifact neu erstellen.'
  },
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'The artifact to change: its file name as created (e.g. "roi-calculator.html") or its id.'
      },
      edits: {
        type: 'array',
        description:
          'The replacements, applied in order. Keep each oldText short but unique: a few lines around the change, copied exactly (whitespace and quotes included).',
        items: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: 'Text to replace, exactly as it is in the current file.'
            },
            newText: {
              type: 'string',
              description: 'The replacement; an empty string deletes oldText.'
            }
          },
          required: ['oldText', 'newText']
        }
      }
    },
    required: ['filename', 'edits']
  }
};
