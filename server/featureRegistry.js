import { ServiceError } from './utils/ServiceError.js';
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Feature Registry
 *
 * Central registry of all toggleable platform features.
 * Single source of truth for feature IDs, names, descriptions,
 * categories, and default states.
 *
 * @module featureRegistry
 */

export const featureRegistry = [
  {
    id: 'skills',
    name: { en: 'Agent Skills', de: 'Agent Skills' },
    description: {
      en: 'Folder-based skill definitions following the Agent Skills standard (agentskills.io)',
      de: 'Ordnerbasierte Skill-Definitionen nach dem Agent Skills Standard (agentskills.io)'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'workflows',
    name: { en: 'Workflows', de: 'Workflows' },
    description: {
      en: 'Agentic workflow automation for multi-step AI tasks',
      de: 'Agentische Workflow-Automatisierung für mehrstufige KI-Aufgaben'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'marketplace',
    name: { en: 'Marketplace', de: 'Marktplatz' },
    description: {
      en: 'Registry-based content discovery and one-click installation of apps, models, prompts, skills, workflows, and integrations',
      de: 'Registry-basierte Inhaltserkennung und Ein-Klick-Installation von Apps, Modellen, Prompts, Skills, Workflows und Integrationen'
    },
    category: 'content',
    default: true
  },
  {
    id: 'integrations',
    name: { en: 'Integrations', de: 'Integrationen' },
    description: {
      en: 'External service integrations (Jira, Cloud Storage)',
      de: 'Externe Dienst-Integrationen (Jira, Cloud Storage)'
    },
    category: 'preview',
    default: true,
    preview: true
  },
  {
    id: 'promptsLibrary',
    name: { en: 'Prompts Library', de: 'Prompt-Bibliothek' },
    description: {
      en: 'Browsable library of reusable prompt templates',
      de: 'Durchsuchbare Bibliothek wiederverwendbarer Prompt-Vorlagen'
    },
    category: 'content',
    default: true
  },
  {
    id: 'usageTracking',
    name: { en: 'Usage Tracking', de: 'Nutzungsverfolgung' },
    description: {
      en: 'Track token usage, request counts, and costs per user/model',
      de: 'Token-Nutzung, Anfragenzählung und Kosten pro Benutzer/Modell verfolgen'
    },
    category: 'analytics',
    default: true
  },
  {
    id: 'tools',
    name: { en: 'Tool Calling', de: 'Tool-Aufrufe' },
    description: {
      en: 'Allow AI models to call external tools and functions',
      de: 'KI-Modellen erlauben, externe Tools und Funktionen aufzurufen'
    },
    category: 'ai',
    default: true
  },
  {
    id: 'toolSearch',
    name: { en: 'Tool Search', de: 'Tool-Suche' },
    description: {
      en: 'An app with more integration tools than fit a request sends its biggest integrations as a list and a search instead of in full: the model finds a tool with search_tools and the tools it finds are added to the request. Keeps requests small and tool choice sharp on apps with many integrations. Each app can switch it off or keep an integration always loaded',
      de: 'Eine App mit mehr Integrations-Tools, als in eine Anfrage passen, sendet ihre größten Integrationen als Liste und Suche statt vollständig: Das Modell findet ein Tool mit search_tools, und die gefundenen Tools werden der Anfrage hinzugefügt. Hält Anfragen klein und die Tool-Wahl treffsicher bei Apps mit vielen Integrationen. Jede App kann es abschalten oder eine Integration immer geladen halten'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'projects',
    name: { en: 'Projects', de: 'Projekte' },
    description: {
      en: 'Admin projects: knowledge linked to apps, workflows and agents (the successor of sources)',
      de: 'Admin-Projekte: Wissen, das mit Apps, Workflows und Agenten verknüpft ist (Nachfolger der Quellen)'
    },
    category: 'ai',
    default: true
  },
  {
    id: 'userProjects',
    name: { en: 'User Projects', de: 'Benutzerprojekte' },
    description: {
      en: 'Projects users create themselves: documents, instructions and chats, shared with roles',
      de: 'Projekte, die Benutzer selbst anlegen: Dokumente, Anweisungen und Chats, geteilt mit Rollen'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'compareMode',
    name: { en: 'Compare Mode', de: 'Vergleichsmodus' },
    description: {
      en: 'Compare responses from two different AI models side-by-side',
      de: 'Antworten von zwei verschiedenen KI-Modellen nebeneinander vergleichen'
    },
    category: 'ai',
    default: false
  },
  // `chatHistoryPreview` lived here and gated a sidebar section and a /chats
  // page backed by fixtures. The history UI is now driven by the durable-chat
  // store, so `chatPersistence` is the single switch for keeping chats and
  // showing them (every chat is stored; without it each one is temporary). A
  // saved `chatHistoryPreview: true` is deliberately *not* promoted to it — the preview showed sample data, and this one writes real
  // conversations to disk — so V097 warns instead of deciding.
  {
    id: 'chatPersistence',
    name: { en: 'Chat History', de: 'Chatverlauf' },
    description: {
      en: 'Keep chats in a history signed-in users can reopen on any device — a run keeps going when the browser closes and its answer is waiting in the chat. Every chat is stored on the server either way; without this, each one is temporary: never listed, and deleted after the temporary-chat retention period (24 hours by default)',
      de: 'Chats in einem Verlauf behalten, den angemeldete Benutzer auf jedem Gerät wieder öffnen können — ein Lauf geht weiter, wenn der Browser geschlossen wird, und seine Antwort wartet im Chat. Gespeichert wird jeder Chat ohnehin auf dem Server; ohne diese Funktion ist jeder temporär: nie aufgelistet und nach der Aufbewahrungsdauer für temporäre Chats gelöscht (standardmäßig 24 Stunden)'
    },
    category: 'content',
    default: true
  },
  {
    id: 'chatSharing',
    name: { en: 'Chat Sharing', de: 'Chats teilen' },
    description: {
      en: 'Let users share a stored chat as a read-only link — with users they pick, with anyone signed in, or publicly without sign-in. Requires Chat History. Which of the three is offered, and the limits on a link, are set under Admin → Chat History',
      de: 'Nutzer können einen gespeicherten Chat als schreibgeschützten Link teilen — mit ausgewählten Nutzern, mit allen Angemeldeten oder öffentlich ohne Anmeldung. Erfordert den Chatverlauf. Welche der drei Varianten angeboten werden und die Grenzen eines Links werden unter Admin → Chat-Verlauf festgelegt'
    },
    category: 'content',
    default: false
  },
  {
    id: 'scheduledTasks',
    name: { en: 'Scheduled Tasks', de: 'Geplante Aufgaben' },
    description: {
      en: 'Let users save a prompt as a task that runs by itself — once, on an interval, daily, weekly, monthly, by cron or on demand — as the user, with the app’s tools and integrations. Every run is its own chat. Requires Chat History. Who may create tasks is a group permission; limits are set under Admin → Scheduled Tasks',
      de: 'Nutzer speichern einen Prompt als Aufgabe, die von selbst läuft — einmalig, im Intervall, täglich, wöchentlich, monatlich, per Cron oder auf Abruf — als der Nutzer, mit den Tools und Integrationen der App. Jeder Lauf ist ein eigener Chat. Erfordert den Chatverlauf. Wer Aufgaben anlegen darf, ist eine Gruppenberechtigung; Grenzen werden unter Admin → Geplante Aufgaben festgelegt'
    },
    category: 'content',
    default: true
  },
  {
    id: 'shortLinks',
    name: { en: 'Short Links', de: 'Kurzlinks' },
    description: {
      en: 'Create short URLs linking directly to specific apps',
      de: 'Kurz-URLs erstellen, die direkt zu bestimmten Apps führen'
    },
    category: 'content',
    default: true
  },
  {
    id: 'feedback',
    name: { en: 'Response Feedback', de: 'Antwort-Feedback' },
    description: {
      en: 'Let users rate AI responses with stars and an optional comment. Individual apps can opt out with `features.feedback: false`; storing what was submitted is controlled separately by Feedback Tracking',
      de: 'Benutzer KI-Antworten mit Sternen und einem optionalen Kommentar bewerten lassen. Einzelne Apps können sich mit `features.feedback: false` abmelden; die Speicherung des Eingereichten steuert separat das Feedback-Tracking'
    },
    category: 'content',
    default: true
  },
  {
    id: 'export',
    name: { en: 'Export', de: 'Export' },
    description: {
      en: 'Enable exporting chat conversations and canvas content in various formats (JSON, JSONL, Markdown, HTML, PDF)',
      de: 'Exportieren von Chat-Unterhaltungen und Canvas-Inhalten in verschiedenen Formaten (JSON, JSONL, Markdown, HTML, PDF) aktivieren'
    },
    category: 'content',
    default: true
  },
  {
    id: 'structuredDocumentExtraction',
    name: { en: 'Structured document extraction', de: 'Strukturierte Dokumentextraktion' },
    description: {
      en: 'Keep headings, chapter and list numbers, tables, footnotes, headers and footers of Word files, slide titles and tables of PowerPoint files, OpenDocument files (LibreOffice), spreadsheets as tables (Excel files in uploads only) and page markers, headings and tables of PDF files when uploaded files — and files sent through the API — are turned into text for the model. Turn off to return to plain text extraction; users get the change after reloading the page (at the latest after 30 minutes).',
      de: 'Überschriften, Kapitel- und Listennummern, Tabellen, Fußnoten, Kopf- und Fußzeilen von Word-Dateien, Folientitel und Tabellen von PowerPoint-Dateien, OpenDocument-Dateien (LibreOffice), Tabellenblätter als Tabellen (Excel-Dateien nur bei Uploads) sowie Seitenmarker, Überschriften und Tabellen von PDF-Dateien beibehalten, wenn hochgeladene und über die API gesendete Dateien für das Modell in Text umgewandelt werden. Ausschalten stellt die reine Textextraktion wieder her; Nutzer erhalten die Änderung nach dem Neuladen der Seite (spätestens nach 30 Minuten).'
    },
    category: 'content',
    default: true
  },
  {
    id: 'toolsService',
    name: { en: 'Tools Service', de: 'Tools-Dienst' },
    description: {
      en: 'Background processing tools like AI OCR with progress tracking',
      de: 'Hintergrund-Verarbeitungstools wie AI-OCR mit Fortschrittsverfolgung'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'appAsTool',
    name: { en: 'App-as-Tool', de: 'App-als-Tool' },
    description: {
      en: 'Allow apps and agents to invoke other iHub apps as synthetic tools (app__<id>) — e.g. a concierge app delegating to specialist apps.',
      de: 'Apps und Agenten erlauben, andere iHub-Apps als synthetische Tools (app__<id>) aufzurufen — z. B. eine Concierge-App, die an Spezial-Apps delegiert.'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'voiceMode',
    name: { en: 'Voice Mode', de: 'Sprachmodus' },
    description: {
      en: 'Spoken conversation with an app: talk, hear the answer read aloud, and interrupt at any time. Needs a speech-to-text and a text-to-speech model (Admin → Voice Input).',
      de: 'Gesprochene Unterhaltung mit einer App: sprechen, die Antwort vorgelesen bekommen und jederzeit unterbrechen. Benötigt ein Speech-to-Text- und ein Text-to-Speech-Modell (Admin → Spracheingabe).'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'runLog',
    name: { en: 'Run Ledger (RunLog)', de: 'Run-Ledger (RunLog)' },
    description: {
      en: 'Persist an append-only per-run event ledger (chats, workflows, agents, inference) under contents/data/run-log for audit, replay and durable interactions',
      de: 'Ein anhängbares Ereignis-Ledger pro Lauf (Chats, Workflows, Agenten, Inferenz) unter contents/data/run-log für Audit, Replay und dauerhafte Interaktionen speichern'
    },
    // On by default and not `preview`: durable chats depend on the ledger. A
    // feature that leaves preview also leaves the Preview category — a row
    // under that heading without the badge reads as an oversight in the one
    // place an admin decides what to trust.
    category: 'platform',
    default: true
  },
  {
    id: 'chatPostStream',
    name: { en: 'Chat answers on one connection', de: 'Chat-Antworten über eine Verbindung' },
    description: {
      en: 'The browser receives a chat answer on the request that sent the message, instead of opening a second stream connection first. Fewer connections per message and less traffic between server workers; turn it off to go back to the separate stream',
      de: 'Der Browser empfängt eine Chat-Antwort über die Anfrage, mit der die Nachricht gesendet wurde, statt zuerst eine zweite Stream-Verbindung zu öffnen. Weniger Verbindungen pro Nachricht und weniger Verkehr zwischen den Server-Workern; ausschalten, um zum separaten Stream zurückzukehren'
    },
    category: 'platform',
    // Off until measured (rollout phase 5 turns it on).
    default: false
  },
  {
    id: 'parallelToolCalls',
    name: {
      en: 'Read-only tool calls side by side',
      de: 'Lesende Tool-Aufrufe nebeneinander'
    },
    description: {
      en: 'When a model asks for several tool calls in one step and all of them only read (a search, a page read, a document lookup), a chat runs up to four of them at the same time instead of one after the other. A call that changes something, asks a question or needs an approval still runs alone. A model can be excluded in its settings',
      de: 'Fordert ein Modell in einem Schritt mehrere Tool-Aufrufe an, die alle nur lesen (eine Suche, das Lesen einer Seite, das Nachschlagen in Dokumenten), führt ein Chat bis zu vier davon gleichzeitig aus statt nacheinander. Ein Aufruf, der etwas ändert, eine Frage stellt oder eine Freigabe braucht, läuft weiterhin allein. Ein Modell kann in seinen Einstellungen ausgenommen werden'
    },
    category: 'preview',
    default: false,
    preview: true
  },
  {
    id: 'steering',
    name: {
      en: 'Messages while iHub is working',
      de: 'Nachrichten während der Antwort'
    },
    description: {
      en: 'While an answer is being written, the person it is written for can send a message into it: iHub reads it at its next step, or sends it as the next message once the answer is done. A message that waits can be removed until iHub has read it. The chat page offers it in its input (Stop and Send are then two buttons); the Outlook add-in and the browser extension do not',
      de: 'Während eine Antwort geschrieben wird, kann die Person, für die sie geschrieben wird, eine Nachricht hineinschicken: iHub liest sie beim nächsten Schritt oder sendet sie als nächste Nachricht, sobald die Antwort fertig ist. Eine wartende Nachricht kann entfernt werden, bis iHub sie gelesen hat. Die Chat-Seite bietet dies in ihrer Eingabe an (Stoppen und Senden sind dann zwei Schaltflächen); das Outlook-Add-in und die Browser-Erweiterung nicht'
    },
    category: 'preview',
    default: false,
    preview: true
  }
];

export const featureCategories = {
  preview: { name: { en: 'Preview', de: 'Vorschau' }, order: 1 },
  ai: { name: { en: 'AI Capabilities', de: 'KI-Funktionen' }, order: 2 },
  content: { name: { en: 'Content', de: 'Inhalte' }, order: 3 },
  analytics: { name: { en: 'Analytics', de: 'Analytik' }, order: 4 },
  platform: { name: { en: 'Platform', de: 'Plattform' }, order: 5 }
};

/**
 * Resolve all features with their current enabled state.
 * Merges registry defaults with the saved feature configuration.
 *
 * @param {Object} featureConfig - Saved feature flags from features.json
 * @returns {Object[]} Array of feature objects with `enabled` field
 */
export function resolveFeatures(featureConfig = {}) {
  return featureRegistry.map(f => ({
    ...f,
    enabled: featureConfig[f.id] ?? f.default
  }));
}

/**
 * Check if a specific feature is enabled.
 *
 * @param {string} featureId - Feature ID to check
 * @param {Object} featureConfig - Saved feature flags from features.json
 * @returns {boolean} True if the feature is enabled
 */
export function isFeatureEnabled(featureId, featureConfig = {}) {
  const entry = featureRegistry.find(f => f.id === featureId);
  if (!entry) return true; // Unknown features are enabled by default
  return featureConfig[featureId] ?? entry.default;
}

/** The ids of all registered features. */
export const FEATURE_IDS = featureRegistry.map(f => f.id);

/**
 * Whether every feature an app lists in `requiredFeatures` is on. An app whose
 * features are not all on is unavailable to users, like a disabled app. An id
 * the registry does not know (a typo) counts as off, so the app stays hidden.
 *
 * @param {Object} app - App config
 * @param {Object} featureConfig - Saved feature flags from features.json
 * @returns {boolean} True if the app requires no feature that is off
 */
export function areAppFeaturesEnabled(app, featureConfig = {}) {
  const required = Array.isArray(app?.requiredFeatures) ? app.requiredFeatures : [];
  return required.every(
    featureId => FEATURE_IDS.includes(featureId) && isFeatureEnabled(featureId, featureConfig)
  );
}

/**
 * Express middleware factory that gates a route behind a feature flag.
 * Returns 403 with code FEATURE_DISABLED when the feature is off.
 *
 * @param {string} featureId - Feature ID to check
 * @returns {Function} Express middleware
 */
export function requireFeature(featureId) {
  // Lazy import to avoid circular dependency at module load time
  let _configCache;
  return async (req, res, next) => {
    if (!_configCache) {
      _configCache = (await import('./configCache.js')).default;
    }
    if (!isFeatureEnabled(featureId, _configCache.getFeatures())) {
      return next(new ServiceError('FEATURE_DISABLED', `Feature '${featureId}' is not enabled`));
    }
    next();
  };
}
