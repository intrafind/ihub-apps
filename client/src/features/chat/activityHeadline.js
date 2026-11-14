// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the run activity list says about the turn, as pure functions of the
 * activity (`buildToolActivity`) and a translate function: the label of a row,
 * the one-line headline, and which mode that headline is in. The component
 * (`ToolActivity`), the three-dot loader in `ChatMessage` and the screen-reader
 * announcer all read the same answers from here, so they cannot disagree.
 *
 * Nothing here infers what a call is from its tool id, a provider or the old
 * `scope`: a row is what the server said it is (`activityKind`, `activityOrigin`
 * as `origin`, `outputKind`, the title), and a row it said nothing about is
 * worded generically.
 *
 * @module features/chat/activityHeadline
 */
import { hostnameOf } from '../../../../shared/run/groundingSources.js';
import { KIND_ICON, MAX_NAMED_KINDS } from './components/answerBasisModel';

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
  document: 'document-plus',
  pdf: 'document-plus',
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

/** The origins that have phrases of their own (`toolActivity.origin.<origin>.*`); an integration is named by its label. */
const PHRASED_ORIGINS = new Set(['web', 'project', 'ifinder', 'iassistant', 'documents']);

/** The origin of a row when it has phrases of its own, else null (older server, unclassified call). */
function phrasedOrigin(item) {
  return PHRASED_ORIGINS.has(item?.origin) ? item.origin : null;
}

/** The icon of a row's origin (the footer's glyph for the kind), or null. */
export function originIconOf(item) {
  return item?.origin ? KIND_ICON[item.origin] || null : null;
}

/**
 * The noun of an origin, as the footer says it: "Web", "Project", "Document
 * sources", and for a connected system its own label ("Jira").
 */
export function originNounOf(t, item) {
  if (item.origin === 'integration') {
    return item.integration || t('chatMessage.answerBasis.kind.integration');
  }
  if (item.origin === 'documents') return t('toolActivity.originDocuments');
  return t(`chatMessage.answerBasis.kind.${item.origin}`);
}

/** "Searching the web for “q”", "Searching the project…"; generic when the origin is unknown. */
function searchLabel(t, item) {
  const query = item.query || item.queries?.[item.queries.length - 1];
  const origin = phrasedOrigin(item);
  if (origin) {
    return query
      ? t(`toolActivity.origin.${origin}.searchingFor`, { query })
      : t(`toolActivity.origin.${origin}.searching`);
  }
  return query
    ? t('toolActivity.searchingFor', 'Searching for “{{query}}”', { query })
    : t('toolActivity.searchingGeneric');
}

/** "Opening host" for a web page, "Opening “title”" for a document; generic when not yet known. */
function fetchLabel(t, item) {
  const origin = phrasedOrigin(item);
  const host = item.url ? hostnameOf(item.url) : null;
  if (origin === 'web' && host) return t('toolActivity.origin.web.opening', { host });
  if (origin && origin !== 'web' && item.title) {
    return t(`toolActivity.origin.${origin}.opening`, { title: item.title });
  }
  if (!origin && host) return t('toolActivity.openingHost', { host });
  return t('toolActivity.openingGeneric');
}

/**
 * The phrase of a finished or running search row, before its query chip:
 * "Searched the project for". Generic ("Searched for") when the server named no origin.
 */
export function searchRowPhrase(t, item) {
  const origin = phrasedOrigin(item);
  const running = item.status === 'running';
  if (!origin) return t('toolActivity.searchedFor', 'Searched for');
  return t(`toolActivity.origin.${origin}.${running ? 'rowSearching' : 'rowSearched'}`);
}

/** The phrase of a page or document read row: "Opened web page", "Web page returned no text", "Opening…". */
export function openRowPhrase(t, item) {
  const origin = phrasedOrigin(item);
  if (item.limitReached) return t('toolActivity.notOpened');
  const running = item.status === 'running';
  if (!origin) return running ? t('toolActivity.openingGeneric') : t('toolActivity.openedGeneric');
  if (running) return t(`toolActivity.origin.${origin}.rowOpening`);
  if (item.readOutcome === 'empty') return t(`toolActivity.origin.${origin}.rowOpenedEmpty`);
  return t(`toolActivity.origin.${origin}.rowOpened`);
}

/**
 * Whether a read counts as opened: it completed, did not hit the page-read
 * limit, the source did not report `read.ok === false`, and the server did not
 * declare that it delivered no text (`readOutcome: 'empty'`).
 */
export function isOpened(item) {
  return (
    item.kind === 'fetch' &&
    item.status === 'completed' &&
    !item.limitReached &&
    item.readOutcome !== 'empty' &&
    item.sources?.[0]?.read?.ok !== false
  );
}

/** The reason a skill is in the answer, in words, or null when the actor is unknown. */
export function skillReasonOf(t, activatedBy) {
  const key = {
    user: 'skillByUser',
    app: 'skillByApp',
    model: 'skillByModel',
    chat: 'skillByChat'
  }[activatedBy];
  return key ? t(`toolActivity.${key}`) : null;
}

/** Facts of one origin's searches: how many results, whether the server declared none. */
function resultFacts(searches) {
  const sourceIds = new Set(searches.flatMap(item => item.sources.map(source => source.id)));
  const declared = searches.reduce((sum, item) => sum + (item.resultCount || 0), 0);
  const results = sourceIds.size || declared;
  const queryCount = searches.reduce(
    (sum, item) => sum + (item.native ? item.queries.length : 1),
    0
  );
  return { results, queryCount };
}

/**
 * The facts of one segment: results (or a declared "no results"), searches
 * (only from two on), opened, calls, failed, and the provider last.
 */
function factsOf(t, group, { alwaysCountSearches = false } = {}) {
  const searches = group.filter(item => item.kind === 'search');
  const opened = group.filter(item => isOpened(item)).length;
  const calls = group.filter(item => item.kind === 'tool').length;
  const failed = group.filter(item => item.status === 'error').length;
  const { results, queryCount } = resultFacts(searches);
  const facts = [];
  // A server-declared zero is the only "no results": an empty list is not.
  const declaredEmpty =
    searches.length > 0 &&
    results === 0 &&
    failed === 0 &&
    searches.every(item => item.resultCount === 0);
  if (results > 0)
    facts.push({ key: 'results', text: t('toolActivity.results', { count: results }) });
  else if (declaredEmpty) {
    facts.push({ key: 'noResults', text: t('toolActivity.noResults'), tone: 'empty' });
  }
  if (searches.length && (queryCount >= 2 || alwaysCountSearches)) {
    facts.push({ key: 'searches', text: t('toolActivity.searches', { count: queryCount }) });
  }
  if (opened) facts.push({ key: 'opened', text: t('toolActivity.openedCount', { count: opened }) });
  if (calls) facts.push({ key: 'calls', text: t('toolActivity.calls', { count: calls }) });
  if (failed) {
    facts.push({
      key: 'failed',
      text: t('toolActivity.failedCount', { count: failed }),
      tone: 'failed'
    });
  }
  const providers = [
    ...new Set(
      group
        .filter(item => item.kind !== 'tool')
        .map(item => item.integration)
        .filter(Boolean)
    )
  ];
  if (providers.length) {
    facts.push({
      key: 'via',
      text: t('toolActivity.via', { name: providers.join(', ') }),
      tone: 'provider'
    });
  }
  return facts;
}

/** What the calls that made something made, and how they ended: "Created web artifact", "Failed", "Stopped". */
function outputSegments(t, items) {
  const made = items.filter(item => hasOutputKind(item));
  const segments = [];
  for (const kind of new Set(made.map(item => item.outputKind))) {
    if (made.some(item => item.outputKind === kind && item.status === 'completed')) {
      segments.push({
        key: `output:${kind}`,
        type: 'output',
        icon: OUTPUT_GLYPHS[kind] || 'wrench',
        noun: createdLabel(t, outputNounOf(t, kind)),
        facts: []
      });
    }
  }
  const failed = made.some(item => item.status === 'error');
  const stopped = made.some(item => item.status === 'stopped');
  if (failed || stopped) {
    segments.push({
      key: 'output:status',
      type: 'output',
      icon: failed ? 'exclamation-circle' : 'wrench',
      noun: failed ? failedLabel(t) : stoppedLabel(t),
      tone: failed ? 'failed' : null,
      facts: []
    });
  }
  return segments;
}

/** The skills of the turn, once each, as segments: one each up to two, then one names-only segment. */
function skillSegments(t, items) {
  const skills = items.filter(item => item.kind === 'skill');
  if (skills.length === 0) return [];
  if (skills.length >= 3) {
    return [
      {
        key: 'skills',
        type: 'skills',
        icon: 'academic-cap',
        names: skills.map(skill => skill.name),
        facts: []
      }
    ];
  }
  return skills.map(skill => ({
    key: `skill:${skill.skillId || skill.name}`,
    type: 'skill',
    icon: 'academic-cap',
    name: skill.name,
    reason: skillReasonOf(t, skill.activatedBy),
    facts: []
  }));
}

/**
 * The segments of the finished headline, one per place the turn looked, in the
 * order it first looked there: skills first (not origins, so they never count
 * against the limit of named origins), then one segment per origin with its own
 * facts, a neutral one for rows the server said nothing about, then what the
 * turn made. Counts belong to their segment only.
 *
 * @param {Function} t
 * @param {Object[]} items - rows of `buildToolActivity`
 * @returns {{segments: Object[], named: Object[], more: Object[]}}
 *   `named` are the origin and neutral segments shown, `more` the ones the
 *   `+N` stands for; `segments` is the whole headline in order
 */
export function headlineSegments(t, items) {
  const groups = new Map();
  const place = (key, item, meta) => {
    if (!groups.has(key)) groups.set(key, { ...meta, items: [] });
    groups.get(key).items.push(item);
  };
  for (const item of items) {
    if (item.kind === 'skill' || hasOutputKind(item)) continue;
    if (item.origin) {
      const key =
        item.origin === 'integration' ? `integration:${item.integration || ''}` : item.origin;
      place(key, item, { type: 'origin', origin: item.origin, sample: item });
    } else {
      place('neutral', item, { type: 'neutral' });
    }
  }
  const origins = [...groups.entries()].map(([key, group]) => {
    if (group.type === 'neutral') {
      return {
        key,
        type: 'neutral',
        icon: null,
        noun: null,
        facts: factsOf(t, group.items, { alwaysCountSearches: true })
      };
    }
    return {
      key,
      type: 'origin',
      origin: group.origin,
      icon: originIconOf(group.sample),
      noun: originNounOf(t, group.sample),
      // A connected system is named by its label already; its calls carry no provider.
      facts: factsOf(t, group.items)
    };
  });
  const named = origins.slice(0, MAX_NAMED_KINDS);
  const more = origins.slice(MAX_NAMED_KINDS);
  return {
    segments: [...skillSegments(t, items), ...named, ...outputSegments(t, items)],
    named,
    more
  };
}

/** A segment as plain text: "Web 5 results · 3 opened · via Brave Search". */
export function segmentText(t, segment) {
  const facts = segment.facts.map(fact => fact.text).join(' · ');
  if (segment.type === 'skill') {
    return [`${t('toolActivity.skillLabel')} ${segment.name}`, segment.reason]
      .filter(Boolean)
      .join(' · ');
  }
  if (segment.type === 'skills') {
    return `${t('toolActivity.skillsLabel')} ${segment.names.join(', ')}`;
  }
  return [segment.noun, facts].filter(Boolean).join(' ');
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
  if (reading) return t('toolActivity.openingHost', { host: hostnameOf(reading) });
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

/**
 * The summary of what the turn did as one plain string (the segments of
 * {@link headlineSegments} joined): "Web 5 results · via Brave Search  Project
 * no results". The component draws the segments themselves.
 */
export function finishedHeadline(t, items) {
  const { segments, more } = headlineSegments(t, items);
  const text = segments.map(segment => segmentText(t, segment));
  if (more.length) text.push(t('chatMessage.answerBasis.more', { count: more.length }));
  return text.join('  ');
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
      label = finishedHeadline(t, items);
  }
  return { ...headline, label };
}
