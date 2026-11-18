// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { filenameParameter, textEditsParameter } from '../editToolParameters.js';
import { ARTIFACT_LIBRARIES } from '../../../../shared/artifactLibraries.js';

// The library kit (#3822), named in the description so the model knows what
// it may load without a CDN: `"chart.js" (Chart.js 4.5.1, defines Chart), …`.
const KIT = ARTIFACT_LIBRARIES.map(
  library => `"${library.id}" (${library.name} ${library.version}, defines ${library.global})`
).join(', ');

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
    en: `Create a self-contained interactive HTML micro-app (.html) — calculators, data explorers, simulators, clickable UI prototypes, HTML5 Canvas/generative visuals — or a standalone vector graphic (.svg), written as HTML or SVG by hand. Rendered live in the chat's Artifacts panel with a Preview | Code toggle and a download card. Inline all CSS and JS in one file. Libraries come from iHub's offline library kit: write <script data-ihub-lib="chart.js"></script> and iHub inlines the library (kit: ${KIT}; the alpinejs marker goes at the end of <body>). Load a library from an allowlisted CDN only when the user explicitly asks for one the kit does not have, or for the CDN. If the result says the kit is switched off on this installation, draw charts as inline SVG and write the code inline instead. Activate the "web-artifacts" skill first for design and sandbox rules. To change an artifact that exists, use edit_web_artifact instead of writing it again.`,
    de: `Erstellt eine eigenständige interaktive HTML-Anwendung (.html) – Rechner, Daten-Explorer, Simulatoren, klickbare UI-Prototypen, HTML5-Canvas-Visualisierungen – oder eine Vektorgrafik (.svg), von Hand als HTML bzw. SVG geschrieben. Wird direkt im Artefakte-Panel mit Vorschau-|Code-Umschalter sowie als Download-Karte angezeigt. Gesamtes CSS und JS in einer Datei einbetten. Bibliotheken kommen aus dem Offline-Bibliotheks-Kit von iHub: <script data-ihub-lib="chart.js"></script> schreiben, iHub bettet die Bibliothek ein (Kit: ${KIT}; der alpinejs-Marker steht am Ende von <body>). Eine Bibliothek nur dann von einem freigegebenen CDN laden, wenn die Person ausdrücklich eine verlangt, die das Kit nicht hat, oder das CDN. Meldet das Ergebnis, dass das Kit hier abgeschaltet ist, Diagramme als Inline-SVG zeichnen und den Code direkt einbetten. Zuerst den Skill "web-artifacts" aktivieren. Ein vorhandenes Artefakt mit edit_web_artifact ändern, statt es neu zu schreiben.`
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
          'Artifact type: "html" for interactive single-file web apps/visualizations (default), "svg" for standalone vector graphics.'
      },
      title: {
        type: 'string',
        description: 'Optional title of the artifact.'
      },
      content: {
        type: 'string',
        description:
          'Complete, self-contained HTML document (<!DOCTYPE html>… with inline <style> and <script>) or <svg xmlns="http://www.w3.org/2000/svg" viewBox="…"> markup.'
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
    required: ['filename', 'content']
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
      filename: filenameParameter('roi-calculator.html', 'artifact'),
      edits: textEditsParameter(
        'The replacements, applied in order. Keep each oldText short but unique: a few lines around the change, copied exactly (whitespace and quotes included).'
      )
    },
    required: ['filename', 'edits']
  }
};
