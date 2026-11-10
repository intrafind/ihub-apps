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
    en: 'Create a self-contained interactive HTML micro-app (.html) — dashboards, calculators, data explorers, simulators, clickable UI prototypes, HTML5 Canvas/generative visuals — or a standalone vector graphic (.svg). Rendered live in the chat\'s Artifacts panel with a Preview | Code toggle and a download card. Inline all CSS and JS in one file. Activate the "web-artifacts" skill first for design and sandbox rules.',
    de: 'Erstellt eine eigenständige interaktive HTML-Anwendung (.html) – Dashboards, Rechner, Daten-Explorer, Simulatoren, klickbare UI-Prototypen, HTML5-Canvas-Visualisierungen – oder eine Vektorgrafik (.svg). Wird direkt im Artefakte-Panel mit Vorschau-|Code-Umschalter sowie als Download-Karte angezeigt. Gesamtes CSS und JS in einer Datei einbetten. Zuerst den Skill "web-artifacts" aktivieren.'
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
