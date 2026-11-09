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
    'Incomplete — the model reached its output limit before the file was finished.'
  ],
  invalid: [
    'toolActivity.invalidArguments',
    'Incomplete — the file data from the model could not be read.'
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
    : t('toolActivity.stoppedUnfinished', 'Stopped — the unfinished file was not saved.');
}

/** The idle line: "Thinking…" while the model reasons, else "Waiting for the model…". */
export function idleLabel(t, kind) {
  return kind === 'thinking'
    ? t('toolActivity.thinking', 'Thinking…')
    : t('toolActivity.waitingForModel', 'Waiting for the model…');
}

/**
 * A label without its trailing ellipsis: screen readers read "…" in
 * inconsistent ways, and a row names what is happening without trailing dots.
 */
export function stripEllipsis(text) {
  return String(text ?? '')
    .replace(/\s*(…|\.{3})\s*$/, '')
    .trim();
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
  if (item?.kind === 'search') {
    const query = item.query || item.queries?.[item.queries.length - 1];
    if (query) return t('toolActivity.searchingFor', 'Searching for “{{query}}”', { query });
    return item.scope === 'documents'
      ? t('toolActivity.searchingDocuments', 'Searching documents…')
      : t('toolActivity.searching', 'Searching the web…');
  }
  if (item?.kind === 'fetch' && item.scope === 'documents') {
    return item.title
      ? t('toolActivity.readingDocument', 'Reading “{{title}}”', { title: item.title })
      : t('toolActivity.readingDocuments', 'Reading documents…');
  }
  if (item?.kind === 'fetch') {
    return item.url
      ? t('toolActivity.reading', 'Reading {{host}}', { host: hostnameOf(item.url) })
      : t('toolActivity.searching', 'Searching the web…');
  }
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

/**
 * The summary of what the turn did: "Searched the web · 1 search · 5 results ·
 * Created web artifact". A call that made something is named by what it made
 * and how it ended, not counted as a tool call: "1 tool call" says nothing
 * about the thing the user asked for, and a stopped or failed turn must not
 * read like success.
 */
export function finishedHeadline(t, items, searches) {
  const parts = [];
  if (searches.length) {
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
  } else {
    const fetches = items.filter(item => item.kind === 'fetch');
    if (fetches.some(item => item.scope !== 'documents')) {
      parts.push(t('toolActivity.readWeb', 'Read the web'));
    }
    if (fetches.some(item => item.scope === 'documents')) {
      parts.push(t('toolActivity.readDocuments', 'Read documents'));
    }
  }
  const pagesRead = countRead(items, 'web');
  if (pagesRead) parts.push(t('toolActivity.pagesRead', { count: pagesRead }));
  const documentsRead = countRead(items, 'documents');
  if (documentsRead) parts.push(t('toolActivity.documentsRead', { count: documentsRead }));
  // Distinct skills: one that was activated twice is still one skill.
  const skills = new Set(
    items.filter(item => item.kind === 'skill').map(item => item.skillId || item.name)
  ).size;
  if (skills) parts.push(t('toolActivity.skills', { count: skills }));
  const made = items.filter(hasOutputKind);
  const others = items.filter(item => item.kind === 'tool' && !hasOutputKind(item));
  if (others.length) parts.push(t('toolActivity.toolCalls', { count: others.length }));
  for (const kind of new Set(made.map(item => item.outputKind))) {
    if (made.some(item => item.outputKind === kind && item.status === 'completed')) {
      parts.push(createdLabel(t, outputNounOf(t, kind)));
    }
  }
  if (made.some(item => item.status === 'error')) parts.push(failedLabel(t));
  if (made.some(item => item.status === 'stopped'))
    parts.push(t('toolActivity.stopped', 'Stopped'));
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
  const made = items.filter(hasOutputKind);
  if (made.some(item => item.status === 'error'))
    return { name: 'exclamation-circle', failed: true };
  if (items.length && made.length === items.length) {
    return { name: outputGlyphOf(made[made.length - 1], 'wrench'), failed: false };
  }
  // Skill and plain tool rows do not say where the turn looked, so they do not
  // decide the icon between the web and the organisation's documents.
  const isPlain = item => item.kind === 'tool' || item.kind === 'skill';
  const onlyDocuments = items.every(item => isPlain(item) || item.scope === 'documents');
  const name = items.every(item => item.kind === 'skill')
    ? 'sparkles'
    : items.every(isPlain)
      ? 'wrench'
      : onlyDocuments
        ? 'document-text'
        : 'globe-alt';
  return { name, failed: false };
}

const lastWhere = (list, test) => [...list].reverse().find(test) || null;

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
  const busyCount = items.filter(isActiveItem).length;
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
      label = idleLabel(t, activity.idle.kind);
      break;
    default:
      label = finishedHeadline(t, items, searches);
  }
  return { ...headline, label };
}
