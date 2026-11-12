// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the run activity list says about the turn, as pure functions of the
 * activity (`buildToolActivity`) and a translate function: the label of a row,
 * the one-line headline, and which mode that headline is in. The component
 * (`ToolActivity`), the three-dot loader in `ChatMessage` and the screen-reader
 * announcer all read the same answers from here, so they cannot disagree.
 *
 * Nothing here infers what a call is from its tool id: a row is what the
 * server said it is (`activityKind`, `outputKind`, the title).
 *
 * @module features/chat/activityHeadline
 */
import { hostnameOf } from '../../../../shared/run/groundingSources.js';

/** `outputKind` the server sends, to the string key and English default of its noun. */
const OUTPUT_NOUNS = {
  webArtifact: ['toolActivity.outputWebArtifact', 'web artifact'],
  document: ['toolActivity.outputDocument', 'document'],
  presentation: ['toolActivity.outputPresentation', 'presentation'],
  workbook: ['toolActivity.outputWorkbook', 'Excel workbook'],
  pdf: ['toolActivity.outputPdf', 'PDF'],
  file: ['toolActivity.outputFile', 'file'],
  archive: ['toolActivity.outputArchive', 'ZIP archive']
};

/** `outputKind` to the glyph of a finished row; the server chooses the kind, the client only draws it. */
const OUTPUT_GLYPHS = {
  webArtifact: 'code-bracket',
  document: 'document-text',
  pdf: 'document-text',
  presentation: 'presentation-chart-bar',
  workbook: 'table-cells',
  archive: 'archive-box',
  file: 'document'
};

/** Why a call failed before it ran (`errorCode` of a row), as string key and English default. */
export const FAILURE_REASONS = {
  truncated: [
    'toolActivity.cutOff',
    'Incomplete — the model reached its output limit before the call was finished.'
  ],
  invalid: [
    'toolActivity.invalidArguments',
    'Incomplete — the call data from the model could not be read.'
  ],
  dropped: ['toolActivity.dropped', 'Not created — the model’s request could not be used.']
};

/** Whether a row is being worked on: a spinner, an approval or a call under way. */
export function isActiveItem(item) {
  return ['preparing', 'awaiting', 'running'].includes(item?.status);
}

/** Whether the server said what the call makes (`outputKind` it knows a noun for). */
export function hasOutputKind(item) {
  return Boolean(item?.outputKind && OUTPUT_NOUNS[item.outputKind]);
}

/**
 * The noun of what a call makes: "web artifact".
 *
 * @param {Function} t - translate function
 * @param {string|null|undefined} outputKind - the server's `outputKind`
 * @returns {string|null} null for a kind the client has no noun for (the row then reads generically)
 */
export function outputNounOf(t, outputKind) {
  const noun = OUTPUT_NOUNS[outputKind];
  return noun ? t(noun[0], noun[1]) : null;
}

/** The glyph of a finished row for what it made, or `fallback`. */
export function outputGlyphOf(item, fallback) {
  return OUTPUT_GLYPHS[item?.outputKind] || fallback;
}

/** Why the call failed in words, for a row that failed before it ran; null otherwise. */
export function failureReasonOf(t, item) {
  const reason = FAILURE_REASONS[item?.errorCode];
  return reason ? t(reason[0], reason[1]) : null;
}

/** "Created web artifact" */
export function createdLabel(t, noun) {
  return t('toolActivity.created', 'Created {{what}}', { what: noun });
}

/** "Creating web artifact…" */
export function creatingLabel(t, noun) {
  return t('toolActivity.creating', 'Creating {{what}}…', { what: noun });
}

/** "Waiting for approval" */
export function awaitingApprovalLabel(t) {
  return t('toolActivity.awaitingApproval', 'Waiting for approval');
}

/** The caption of a call whose size has not grown for a while. */
export function stalledLabel(t) {
  return t(
    'toolActivity.stalled',
    'No new output for a while. The model may be busy — you can wait or stop.'
  );
}

/** "Failed" */
export function failedLabel(t) {
  return t('toolActivity.failed', 'Failed');
}

/** "Stopped" */
export function stoppedLabel(t) {
  return t('toolActivity.stopped', 'Stopped');
}

/** "No. 2": the chip of the second and later call of the same tool in a turn. */
export function occurrenceLabel(t, count) {
  return t('toolActivity.occurrence', 'No. {{count}}', { count });
}

/**
 * Why a file call that never ran ended without a result: stopped while the
 * model was still writing it, or after it was written but before it ran.
 */
export function stoppedUnstartedLabel(t, item) {
  return item?.argsComplete
    ? t('toolActivity.notRun', 'Not run')
    : t('toolActivity.stoppedUnfinished', 'Stopped — the unfinished call was not run.');
}

/**
 * The idle line: "Thinking…" while the model reasons, "Refreshing outdated
 * documents…" while the turn waits for them (#3622), else "Waiting for the
 * model…".
 *
 * @param {Function} t
 * @param {string} kind
 * @param {{total?: number, done?: number}} [idle] - The counts of `refreshing`.
 */
export function idleLabel(t, kind, idle = {}) {
  if (kind === 'refreshing') {
    return t(
      'toolActivity.refreshingDocuments',
      'Refreshing outdated documents… {{done}} of {{total}}',
      {
        done: idle.done ?? 0,
        total: idle.total ?? 0
      }
    );
  }
  return kind === 'thinking'
    ? t('toolActivity.thinking', 'Thinking…')
    : t('toolActivity.waitingForModel', 'Waiting for the model…');
}

/**
 * A label without its trailing ellipsis: screen readers read "…" in
 * inconsistent ways, and a row names what is happening without trailing dots.
 */
export function stripEllipsis(text) {
  // A check of the end, not a regular expression: a pattern for "whitespace,
  // dots, whitespace" backtracks badly on a long run of whitespace.
  const plain = String(text ?? '').trimEnd();
  if (plain.endsWith('…')) return plain.slice(0, -1).trim();
  if (plain.endsWith('...')) return plain.slice(0, -3).trim();
  return plain.trim();
}

/** Sources read, by scope — a document shows up on its search hit and on the read that fetched it. */
function countRead(items, scope) {
  const keys = items
    .filter(item => (item.scope === 'documents') === (scope === 'documents'))
    .flatMap(item => item.sources.filter(source => source.read?.ok).map(source => source.id));
  return new Set(keys).size;
}

function countSources(items) {
  return new Set(items.flatMap(item => item.sources.map(source => source.id))).size;
}

/** "Searching for “query”", or what kind of search it is when its query is not known. */
function searchLabel(t, item) {
  const query = item.query || item.queries?.[item.queries.length - 1];
  if (query) return t('toolActivity.searchingFor', 'Searching for “{{query}}”', { query });
  return item.scope === 'documents'
    ? t('toolActivity.searchingDocuments', 'Searching documents…')
    : t('toolActivity.searching', 'Searching the web…');
}

/** "Reading “title”" for a document, "Reading host" for a page. */
function fetchLabel(t, item) {
  if (item.scope === 'documents') {
    return item.title
      ? t('toolActivity.readingDocument', 'Reading “{{title}}”', { title: item.title })
      : t('toolActivity.readingDocuments', 'Reading documents…');
  }
  return item.url
    ? t('toolActivity.reading', 'Reading {{host}}', { host: hostnameOf(item.url) })
    : t('toolActivity.searching', 'Searching the web…');
}

/**
 * What a call that is being prepared or runs is doing, as the headline says it
 * ("Creating web artifact…", "Searching for “…”", "Preparing Search people…").
 *
 * @param {Function} t - translate function
 * @param {Object} item - a row of `buildToolActivity` that is `preparing` or `running`
 * @param {string|null} [reading] - the page a search is fetching right now
 * @returns {string}
 */
export function activeLabel(t, item, reading = null) {
  const noun = outputNounOf(t, item?.outputKind);
  if (noun) return creatingLabel(t, noun);
  if (item?.status === 'preparing') {
    return t('toolActivity.preparingTool', 'Preparing {{name}}…', { name: item.name });
  }
  if (reading) return t('toolActivity.reading', 'Reading {{host}}', { host: hostnameOf(reading) });
  if (item?.kind === 'search') return searchLabel(t, item);
  if (item?.kind === 'fetch') return fetchLabel(t, item);
  if (item?.integration) {
    return t('toolActivity.runningToolIn', '{{name}} · {{integration}}…', {
      name: item.name,
      integration: item.integration
    });
  }
  return t('toolActivity.runningTool', 'Running {{name}}', { name: item?.name || '' });
}

/** The headline while a call runs: the newest running row, or the page being read. */
export function runningHeadline(t, items, reading) {
  const current = [...items].reverse().find(item => item.status === 'running');
  // A page is only being fetched while a search or read of the turn is running.
  return activeLabel(t, current, reading);
}

/** "Searched the web · 1 search · 5 results", or what was read when the turn only read. */
function searchedParts(t, items, searches) {
  const parts = [];
  if (!searches.length) {
    const fetches = items.filter(item => item.kind === 'fetch');
    if (fetches.some(item => item.scope !== 'documents')) {
      parts.push(t('toolActivity.readWeb', 'Read the web'));
    }
    if (fetches.some(item => item.scope === 'documents')) {
      parts.push(t('toolActivity.readDocuments', 'Read documents'));
    }
    return parts;
  }
  if (searches.some(item => item.scope !== 'documents')) {
    parts.push(t('toolActivity.searchedWeb', 'Searched the web'));
  }
  if (searches.some(item => item.scope === 'documents')) {
    parts.push(t('toolActivity.searchedDocuments', 'Searched documents'));
  }
  const queryCount = searches.reduce(
    (sum, item) => sum + (item.native ? item.queries.length : 1),
    0
  );
  parts.push(t('toolActivity.searches', { count: queryCount }));
  // Results, not sources: only what the answer cites is a source of it.
  const results = countSources(items);
  if (results) parts.push(t('toolActivity.results', { count: results }));
  return parts;
}

/** "1 page read", "2 documents read". */
function readParts(t, items) {
  const parts = [];
  const pagesRead = countRead(items, 'web');
  if (pagesRead) parts.push(t('toolActivity.pagesRead', { count: pagesRead }));
  const documentsRead = countRead(items, 'documents');
  if (documentsRead) parts.push(t('toolActivity.documentsRead', { count: documentsRead }));
  return parts;
}

/** What the calls that made something made, and how they ended: "Created web artifact · Stopped". */
function madeParts(t, items) {
  const made = items.filter(item => hasOutputKind(item));
  const parts = [];
  for (const kind of new Set(made.map(item => item.outputKind))) {
    if (made.some(item => item.outputKind === kind && item.status === 'completed')) {
      parts.push(createdLabel(t, outputNounOf(t, kind)));
    }
  }
  if (made.some(item => item.status === 'error')) parts.push(failedLabel(t));
  if (made.some(item => item.status === 'stopped')) parts.push(stoppedLabel(t));
  return parts;
}

/**
 * The summary of what the turn did: "Searched the web · 1 search · 5 results ·
 * Created web artifact". A call that made something is named by what it made
 * and how it ended, not counted as a tool call: "1 tool call" says nothing
 * about the thing the user asked for, and a stopped or failed turn must not
 * read like success.
 */
export function finishedHeadline(t, items, searches) {
  const parts = [...searchedParts(t, items, searches), ...readParts(t, items)];
  // Distinct skills: one that was activated twice is still one skill.
  const skills = new Set(
    items.filter(item => item.kind === 'skill').map(item => item.skillId || item.name)
  ).size;
  if (skills) parts.push(t('toolActivity.skills', { count: skills }));
  const others = items.filter(item => item.kind === 'tool' && !hasOutputKind(item));
  if (others.length) parts.push(t('toolActivity.toolCalls', { count: others.length }));
  parts.push(...madeParts(t, items));
  // The systems the turn asked, so the summary says where the answer came from.
  const integrations = [...new Set(items.map(item => item.integration).filter(Boolean))];
  if (integrations.length) parts.push(integrations.join(', '));
  return parts.join(' · ');
}

/**
 * The icon of the summary line: what the turn made, a failure of it, or where
 * it looked.
 *
 * @returns {{name: string, failed: boolean}}
 */
export function summaryIconOf(items) {
  const made = items.filter(item => hasOutputKind(item));
  if (made.some(item => item.status === 'error')) {
    return { name: 'exclamation-circle', failed: true };
  }
  if (items.length && made.length === items.length) {
    return { name: outputGlyphOf(made[made.length - 1], 'wrench'), failed: false };
  }
  return { name: lookedAtIcon(items), failed: false };
}

/**
 * The icon of a turn that made nothing: where it looked. Skill and plain tool
 * rows do not say where the turn looked, so they do not decide the icon
 * between the web and the organisation's documents.
 */
function lookedAtIcon(items) {
  if (items.every(item => item.kind === 'skill')) return 'sparkles';
  const isPlain = item => item.kind === 'tool' || item.kind === 'skill';
  if (items.every(item => isPlain(item))) return 'wrench';
  const onlyDocuments = items.every(item => isPlain(item) || item.scope === 'documents');
  return onlyDocuments ? 'document-text' : 'globe-alt';
}

const lastWhere = (list, matches) => [...list].reverse().find(item => matches(item)) || null;

/**
 * Which line the headline is, first match wins (UX brief 3.3):
 *
 * 1. `awaiting`: a call waits for the user's approval
 * 2. `summary`: the turn is over (what it did, and how it ended)
 * 3. `preparing`: the model is writing a call's arguments (the newest row owns the line)
 * 4. `running`: a call runs
 * 5. `idle`: the model has been silent for a while ("Waiting for the model…", "Thinking…")
 * 6. `summary` without a spinner: the answer is streaming
 * 7. `between`: a turn that is still going, nothing active (the summary so far, with a spinner)
 *
 * Pure and label-free, so the loader in `ChatMessage` can ask "is the headline
 * busy?" without a translate function.
 *
 * @param {{items?: Object[], idle?: Object, answering?: boolean}|null} activity
 * @param {boolean} loading - the turn is still going
 * @returns {{mode: string, owner: Object|null, more: number, busy: boolean, active: boolean}}
 */
export function headlineModeOf(activity, loading) {
  const items = activity?.items || [];
  const busyCount = items.filter(item => isActiveItem(item)).length;
  const awaiting = lastWhere(items, item => item.status === 'awaiting');
  if (awaiting) return { mode: 'awaiting', owner: awaiting, more: 0, busy: false, active: true };
  if (!loading) return { mode: 'summary', owner: null, more: 0, busy: false, active: false };

  // A call whose arguments are complete only waits for its turn to run: it
  // owns the line only when no other call is still being written.
  const preparing =
    lastWhere(items, item => item.status === 'preparing' && !item.ready) ||
    lastWhere(items, item => item.status === 'preparing');
  if (preparing) {
    return {
      mode: 'preparing',
      owner: preparing,
      more: Math.max(0, busyCount - 1),
      busy: !preparing.ready,
      active: true
    };
  }
  const running = lastWhere(items, item => item.status === 'running');
  if (running) return { mode: 'running', owner: running, more: 0, busy: true, active: true };
  if (activity?.idle) return { mode: 'idle', owner: null, more: 0, busy: true, active: true };
  if (activity?.answering)
    return { mode: 'summary', owner: null, more: 0, busy: false, active: false };
  return { mode: 'between', owner: null, more: 0, busy: true, active: false };
}

/**
 * Whether the headline shows a spinner or a label of its own, so the three-dot
 * loader of the message stands down (two loaders on one message are one too
 * many). False once the turn is over, and while the answer itself streams.
 *
 * @param {Object|null} activity - see `headlineModeOf`
 * @param {boolean} loading - the turn is still going
 * @returns {boolean}
 */
export function isActivityLineBusy(activity, loading) {
  return Boolean(activity && loading && headlineModeOf(activity, true).busy);
}

/**
 * The headline: its mode and its text.
 *
 * @param {Function} t - translate function
 * @param {Object|null} activity - see `headlineModeOf`
 * @param {boolean} loading
 * @returns {{mode: string, owner: Object|null, more: number, busy: boolean, active: boolean, label: string}}
 */
export function headlineOf(t, activity, loading) {
  const items = activity?.items || [];
  const headline = headlineModeOf(activity, loading);
  const searches = items.filter(item => item.kind === 'search');
  let label;
  switch (headline.mode) {
    case 'awaiting':
      label = awaitingApprovalLabel(t);
      break;
    case 'preparing':
      label = activeLabel(t, headline.owner);
      break;
    case 'running':
      label = runningHeadline(t, items, activity.reading);
      break;
    case 'idle':
      label = idleLabel(t, activity.idle.kind, activity.idle);
      break;
    default:
      label = finishedHeadline(t, items, searches);
  }
  return { ...headline, label };
}
