// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { hostnameOf } from '../../../../../shared/run/groundingSources.js';
import { foldSkillItems } from '../../../../../shared/run/toolActivity.js';
import {
  awaitingApprovalLabel,
  createdLabel,
  creatingLabel,
  failedLabel,
  failureReasonOf,
  hasOutputKind,
  headlineOf,
  headlineSegments,
  idleLabel,
  isActiveItem,
  occurrenceLabel,
  openRowPhrase,
  originIconOf,
  outputGlyphOf,
  outputNounOf,
  searchRowPhrase,
  skillReasonOf,
  stoppedLabel,
  stoppedUnstartedLabel,
  stripEllipsis
} from '../activityHeadline.js';
import { isStalled } from '../activityTiming.js';
import { ActivityHint, ArgumentProgress, BusyIcon, RowChip, useNow } from './ActivityProgress';

/** Colour of the label of a call or status that is active right now. */
const ACTIVE_LABEL = 'font-medium text-gray-800 dark:text-gray-200';
const ATTENTION = 'text-amber-700 dark:text-amber-400';

/** The "Technical details" preference, remembered per browser; the page works without storage. */
const DETAILS_KEY = 'ihub.activity.technicalDetails';
const detailsListeners = new Set();
let detailsFallback = false;
// Set when a write to storage failed (a full origin, a blocked write): the
// in-memory value is then the truth, whatever an old stored value says.
let storageFailed = false;

function readDetails() {
  if (storageFailed) return detailsFallback;
  try {
    return globalThis.localStorage?.getItem(DETAILS_KEY) === '1';
  } catch {
    // Storage blocked or unavailable: the in-memory value stands.
    return detailsFallback;
  }
}

function writeDetails(on) {
  detailsFallback = on;
  try {
    globalThis.localStorage?.setItem(DETAILS_KEY, on ? '1' : '0');
    storageFailed = false;
  } catch {
    // Not remembered; the switch still works for this page.
    storageFailed = true;
  }
  detailsListeners.forEach(listener => listener());
}

function subscribeDetails(listener) {
  detailsListeners.add(listener);
  return () => detailsListeners.delete(listener);
}

/** `[on, setOn]` of the Technical details switch, shared by every answer on the page. */
function useTechnicalDetails() {
  const on = useSyncExternalStore(subscribeDetails, readDetails, () => false);
  return [on, writeDetails];
}

/**
 * What the turn is doing and did: where it looked (the web, a project, iFinder,
 * a connected system), what each search found, which pages and documents it
 * opened, the skills in force, the other tools it called and the files it is
 * writing, and, when it has nothing else to show, that the model is still
 * working.
 *
 * Open while the answer streams, so the user can follow the turn as it
 * happens; collapsed to a summary once the answer is complete, where it stays as
 * provenance: one segment per place it looked, skills first. The headline always
 * carries the current status, so a list the user closed does not hide it.
 *
 * Silent for screen readers (`aria-live="off"`: the chat log around it is a
 * live region, and a ticking clock inside would be read every second). What a
 * screen reader needs is said once by the `RunAnnouncer`; the numbers here are
 * `aria-hidden`.
 *
 * @param {Object} props
 * @param {{items: Array<Object>, reading: string|null, idle?: Object, answering?: boolean}} props.activity
 *   - see shared/run/toolActivity; `idle` makes a headline-only line when there are no rows
 * @param {boolean} [props.loading] - whether the turn is still going
 */
function ToolActivity({ activity, loading = false }) {
  const { t } = useTranslation();
  const listId = useId();
  const hintId = useId();
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  // null = follow the streaming state; a click pins the user's choice.
  const [expanded, setExpanded] = useState(null);
  const [showDetails, setShowDetails] = useTechnicalDetails();

  // One row per distinct skill, whatever stored or live data repeats.
  const items = foldSkillItems(activity?.items || []);
  // The silence of a model call belongs to a turn that is still going.
  const idle = loading ? activity?.idle || null : null;
  const anyActive = items.some(item => isActiveItem(item)) || Boolean(idle);
  // The clock only runs while something is going on.
  const now = useNow(anyActive);

  const open = expanded ?? loading;
  // When the list closes by itself (the turn ended) with the keyboard inside it,
  // focus moves to the headline button instead of falling onto the page.
  const wasOpen = useRef(open);
  const focusWasInside = useRef(false);
  if (wasOpen.current && !open && expanded === null) {
    focusWasInside.current = Boolean(listRef.current?.contains(document.activeElement));
  }
  useLayoutEffect(() => {
    wasOpen.current = open;
    if (!open && focusWasInside.current) {
      focusWasInside.current = false;
      buttonRef.current?.focus();
    }
  }, [open]);

  if (items.length === 0) return idle ? <IdleLine idle={idle} /> : null;
  const headline = headlineOf(t, { ...activity, items }, loading);
  const owner = headline.owner;
  // Arguments, tool and duration have no meaning while a turn is still going.
  const canShowDetails = !loading && open && items.some(item => item.kind !== 'skill');
  const details = canShowDetails && showDetails;

  return (
    <div aria-live="off" className="mb-2 text-xs text-gray-600 dark:text-gray-400">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setExpanded(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className="group inline-flex items-start gap-1.5 max-w-full py-1 -my-1 rounded-sm text-start hover:text-gray-900 dark:hover:text-gray-200 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <Headline headline={headline} items={items} idle={idle} />
        {headline.mode === 'preparing' && (
          <ArgumentProgress
            lead
            argBytes={owner.argBytes}
            elapsedMs={owner.elapsedMs}
            receivedAt={owner.receivedAt}
            running={!owner.ready}
            suffix={owner.ready ? 'readyToRun' : null}
            className="shrink-0 whitespace-nowrap text-gray-500 dark:text-gray-400"
          />
        )}
        {headline.mode === 'idle' && (
          <ArgumentProgress
            lead
            elapsedMs={idle.elapsedMs}
            receivedAt={idle.receivedAt}
            className="shrink-0 whitespace-nowrap text-gray-500 dark:text-gray-400"
          />
        )}
        {headline.more > 0 && (
          // Below 640 px the other calls are on their own rows; the label keeps the room.
          <span
            aria-hidden="true"
            className="shrink-0 whitespace-nowrap text-gray-500 dark:text-gray-400 max-sm:hidden"
          >
            {'· '}
            {t('toolActivity.alsoActive', { count: headline.more })}
          </span>
        )}
        <Icon
          name="chevron-down"
          size="sm"
          className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {canShowDetails && (
        <div className="mt-1.5 ms-1.5">
          <button
            type="button"
            role="switch"
            aria-checked={showDetails}
            aria-describedby={hintId}
            onClick={() => setShowDetails(!showDetails)}
            className="-ms-1 inline-flex min-h-6 items-center gap-2 rounded-md px-1 text-gray-700 dark:text-gray-300 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <span
              aria-hidden="true"
              className={`relative inline-block h-4 w-7 shrink-0 rounded-full border-[1.5px] transition-colors motion-reduce:transition-none ${
                showDetails
                  ? 'border-indigo-600 bg-indigo-600 dark:border-indigo-500 dark:bg-indigo-500'
                  : 'border-gray-500 dark:border-gray-400'
              }`}
            >
              <span
                className={`absolute inset-y-0 left-0.5 my-auto h-[9px] w-[9px] rounded-full transition-transform motion-reduce:transition-none ${
                  showDetails ? 'translate-x-3 bg-white' : 'bg-gray-500 dark:bg-gray-400'
                }`}
              />
            </span>
            <span>{t('toolActivity.technicalDetails')}</span>
          </button>
          <span id={hintId} className="sr-only">
            {t('toolActivity.technicalDetailsHint')}
          </span>
        </div>
      )}
      {open && (
        <ol
          ref={listRef}
          id={listId}
          aria-busy={anyActive}
          className={`${canShowDetails ? 'mt-1' : 'mt-1.5'} ms-1.5 ps-3 border-s border-gray-200 dark:border-gray-700 space-y-1`}
        >
          {items.map(item => (
            <ActivityItem
              key={item.id}
              item={item}
              stalled={isStalled(item, now)}
              details={details}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/** The icon of an idle line when motion is reduced. */
function idleIcon(kind) {
  if (kind === 'thinking') return 'light-bulb';
  return kind === 'refreshing' ? 'arrow-path' : 'clock';
}

/**
 * The idle line of a turn with no rows yet ("Waiting for the model… 0:12",
 * "Thinking… 0:07"): not a button, nothing to expand.
 */
function IdleLine({ idle }) {
  const { t } = useTranslation();
  const label = idleLabel(t, idle.kind, idle);
  return (
    <div
      aria-live="off"
      className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-600 dark:text-gray-400"
    >
      <BusyIcon staticIcon={idleIcon(idle.kind)} />
      <span className={ACTIVE_LABEL}>{label}</span>
      <ArgumentProgress
        lead
        elapsedMs={idle.elapsedMs}
        receivedAt={idle.receivedAt}
        className="whitespace-nowrap text-gray-500 dark:text-gray-400"
      />
    </div>
  );
}

const FACT_TONE = {
  empty: 'text-gray-700 dark:text-gray-300',
  failed: 'text-red-600 dark:text-red-400'
};

/**
 * Facts of a segment or row, each one unbreakable, with a middle dot after it
 * (visible, hidden from screen readers, which hear a comma): a dot trails a
 * line and never starts one.
 */
function Facts({ facts }) {
  return facts.map((fact, index) => (
    <span key={fact.key} className={`whitespace-nowrap ${FACT_TONE[fact.tone] || ''}`}>
      {fact.text}
      {index < facts.length - 1 && (
        <>
          <span aria-hidden="true"> ·</span>
          <span className="sr-only">, </span>
        </>
      )}
      {index < facts.length - 1 && ' '}
    </span>
  ));
}

/** The 16 px slot in front of a segment: its icon, a spinner while the turn is between steps, or empty. */
function SegmentIcon({ segment, busy }) {
  if (busy) return <BusyIcon />;
  if (!segment.icon) return <span aria-hidden="true" className="w-4 shrink-0" />;
  const skill = segment.type === 'skill' || segment.type === 'skills';
  let tone = 'text-gray-500 dark:text-gray-400';
  if (skill) tone = 'text-purple-600 dark:text-purple-400';
  else if (segment.tone === 'failed') tone = 'text-red-500';
  return <Icon name={segment.icon} size="sm" className={`shrink-0 ${tone}`} />;
}

/** One segment of the finished headline: skill, origin, neutral or output. */
function Segment({ segment, busy = false }) {
  const { t } = useTranslation();
  let body;
  if (segment.type === 'skill') {
    body = (
      <>
        <span className="min-w-0 break-words">
          {t('toolActivity.skillLabel')}{' '}
          <span className="font-medium text-purple-700 dark:text-purple-300">{segment.name}</span>
          {segment.reason && (
            <>
              <span aria-hidden="true"> ·</span>
              <span className="sr-only">, </span>
            </>
          )}
        </span>
        {segment.reason && (
          <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">
            {segment.reason}
          </span>
        )}
      </>
    );
  } else if (segment.type === 'skills') {
    body = (
      <span className="min-w-0 break-words">
        {t('toolActivity.skillsLabel')}{' '}
        {segment.names.map((name, index) => (
          <span
            key={name}
            className="whitespace-nowrap font-medium text-purple-700 dark:text-purple-300"
          >
            {name}
            {index < segment.names.length - 1 ? ', ' : ''}
          </span>
        ))}
      </span>
    );
  } else {
    body = (
      <span className="min-w-0">
        {segment.noun && (
          <span
            className={`font-medium me-0.5 ${
              segment.tone === 'failed'
                ? 'text-red-600 dark:text-red-400'
                : 'text-gray-800 group-hover:text-gray-900 dark:text-gray-200 dark:group-hover:text-gray-100'
            }`}
          >
            {segment.noun}
          </span>
        )}
        {segment.noun && segment.facts.length > 0 && <span className="sr-only">: </span>}{' '}
        <Facts facts={segment.facts} />
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5">
      <SegmentIcon segment={segment} busy={busy} />
      {body}
    </span>
  );
}

/**
 * The headline: a label with a spinner or status icon while something runs;
 * once the turn goes on or is over, one segment per place it looked. The
 * words say where; an icon is decoration (a spinner or status icon takes the
 * slot of the first segment while the turn is busy).
 */
function Headline({ headline, items, idle }) {
  const { t } = useTranslation();
  const summary = headline.mode === 'summary' || headline.mode === 'between';
  if (!summary) {
    let lead;
    if (headline.busy) {
      lead = <BusyIcon staticIcon={headline.mode === 'idle' ? idleIcon(idle.kind) : 'clock'} />;
    } else if (headline.mode === 'awaiting') {
      lead = <Icon name="shield-check" size="sm" className={`shrink-0 ${ATTENTION}`} />;
    } else {
      // Arguments complete, a parallel call is still being written: nothing moves here.
      lead = <Icon name="clock" size="sm" className="shrink-0 text-gray-500 dark:text-gray-400" />;
    }
    return (
      <>
        {lead}
        <span
          className={`min-w-0 break-words ${
            headline.active
              ? `${ACTIVE_LABEL} group-hover:text-gray-900 dark:group-hover:text-gray-100`
              : ''
          }`}
        >
          {headline.label}
        </span>
      </>
    );
  }
  const { segments, more } = headlineSegments(t, items);
  return (
    <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
      {segments.map((segment, index) => (
        <Segment key={segment.key} segment={segment} busy={index === 0 && headline.busy} />
      ))}
      {more.length > 0 && (
        <span className="shrink-0 whitespace-nowrap text-gray-500 dark:text-gray-400">
          {t('chatMessage.answerBasis.more', { count: more.length })}
          <span className="sr-only">
            {': '}
            {more.map(segment => segment.noun).join(', ')}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * The lead icon of a row (status wins, otherwise where it looked): a spinner
 * while it runs, a clock while it waits, a shield for an approval, a red
 * exclamation when it failed, else the glyph of its origin (or, for a row the
 * server said nothing about, of its kind). The origin is always in the words
 * too, so the slot can show a status without losing it.
 */
function StatusIcon({ item, fallback }) {
  if (item.status === 'running' || (item.status === 'preparing' && !item.ready)) {
    return <BusyIcon />;
  }
  if (item.status === 'preparing') {
    // Arguments complete, waiting for its turn to run: nothing moves.
    return <Icon name="clock" size="sm" className="shrink-0 text-gray-500 dark:text-gray-400" />;
  }
  if (item.status === 'awaiting') {
    return <Icon name="shield-check" size="sm" className={`shrink-0 ${ATTENTION}`} />;
  }
  if (item.status === 'error') {
    return <Icon name="exclamation-circle" size="sm" className="shrink-0 text-red-500" />;
  }
  return (
    <Icon
      name={outputGlyphOf(item, originIconOf(item) || fallback)}
      size="sm"
      className="shrink-0 text-gray-500 dark:text-gray-400"
    />
  );
}

/**
 * The first line of a row: an icon column and a body that wraps under the
 * phrase, not under the icon (a 24 px strut keeps the icon centred on the first
 * line whatever it holds).
 */
function RowLine({ icon, children }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="flex h-6 shrink-0 items-center">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 before:-me-1.5 before:h-6 before:w-0 before:shrink-0">
        {children}
      </div>
    </div>
  );
}

function ActivityItem({ item, stalled = false, details = false }) {
  if (item.kind === 'skill') return <SkillRow item={item} />;
  // A call whose arguments were never seen to start (still being written,
  // waiting for approval, stopped or refused first) knows no query or page yet:
  // it reads as a plain call, whatever the server said it is.
  const unstarted = item.started === false;
  if (item.kind === 'search' && !unstarted) return <SearchRow item={item} details={details} />;
  if (item.kind === 'fetch' && !unstarted) return <FetchRow item={item} details={details} />;
  return <ToolRow item={item} stalled={stalled} details={details} />;
}

/**
 * A skill in the answer: a status, not a control (no border, no fill, no tab
 * stop), saying who brought it in. Nothing is guessed for a skill whose actor
 * is not known (answers stored before the change).
 */
function SkillRow({ item }) {
  const { t } = useTranslation();
  const reason = skillReasonOf(t, item.activatedBy);
  return (
    <li>
      <RowLine
        icon={
          <Icon name="academic-cap" size="sm" className="text-purple-600 dark:text-purple-400" />
        }
      >
        <span className="min-w-0 break-words">
          {t('toolActivity.skillLabel')}{' '}
          <span className="font-medium text-purple-700 dark:text-purple-300">{item.name}</span>
          {reason && (
            <>
              <span aria-hidden="true"> ·</span>
              <span className="sr-only">, </span>
            </>
          )}
        </span>
        {reason && (
          <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">{reason}</span>
        )}
      </RowLine>
    </li>
  );
}

/** The queries a search row shows: a provider-run search lists its own, a tool call has one. */
function queriesOf(item) {
  if (item.native) return item.queries;
  return item.query ? [item.query] : [];
}

/** The facts of a row: its result count (or a declared "no results"), where it ran, how it ended. */
function rowFacts(t, item, { count = null } = {}) {
  const facts = [];
  if (item.status === 'completed' && count > 0) {
    facts.push({ key: 'results', text: t('toolActivity.results', { count }) });
  } else if (item.status === 'completed' && item.kind === 'search' && item.resultCount === 0) {
    // The server declared it: an empty list alone is not "no results".
    facts.push({ key: 'noResults', text: t('toolActivity.noResults'), tone: 'empty' });
  }
  if (item.integration) {
    facts.push({ key: 'via', text: t('toolActivity.via', { name: item.integration }) });
  }
  if (item.status === 'error') {
    facts.push({ key: 'failed', text: failedLabel(t), tone: 'failed' });
  } else if (item.status === 'awaiting') {
    facts.push({ key: 'awaiting', text: awaitingApprovalLabel(t) });
  } else if (item.status === 'stopped' && !(!item.started && hasOutputKind(item))) {
    facts.push({ key: 'stopped', text: stoppedLabel(t) });
  }
  return facts;
}

function SearchRow({ item, details }) {
  const { t } = useTranslation();
  const queries = queriesOf(item);
  const count = item.sources.length || item.resultCount || 0;
  const facts = rowFacts(t, item, { count });
  return (
    <li>
      <RowLine icon={<StatusIcon item={item} fallback="search" />}>
        <span className={item.status === 'running' ? ACTIVE_LABEL : ''}>
          {queries.length
            ? searchRowPhrase(t, item)
            : t('toolActivity.ranTool', 'Ran {{name}}', { name: item.name })}
        </span>
        {queries.map(query => (
          <span
            key={query}
            className="inline-flex items-center px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700/50 break-all"
          >
            {query}
          </span>
        ))}
        {facts.length > 0 && (
          <span className="text-gray-500 dark:text-gray-400">
            <Facts facts={facts} />
          </span>
        )}
      </RowLine>
      <ItemDetails item={item} show={details} />
      <ItemError item={item} />
      {item.sources.length > 0 && (
        <ul className="ms-5.5 max-sm:space-y-1.5">
          {item.sources.map(source => (
            <SourceRow key={source.id} source={source} />
          ))}
        </ul>
      )}
    </li>
  );
}

function FetchRow({ item, details }) {
  const { t } = useTranslation();
  const page = item.sources[0];
  const url = item.url || page?.url;
  const host = url ? hostnameOf(url) : null;
  const label = page?.title || item.title || host || item.documentId;
  const facts = rowFacts(t, item);
  // A page the reader cut off is "partly read", in plain words and no tooltip.
  if (page?.read?.truncated && item.status === 'completed') {
    facts.unshift({ key: 'partly', text: t('toolActivity.partlyRead') });
  }
  return (
    <li>
      <RowLine icon={<StatusIcon item={item} fallback="document" />}>
        <span className={item.status === 'running' ? ACTIVE_LABEL : ''}>
          {openRowPhrase(t, item)}
        </span>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-6 min-w-0 max-w-full items-center rounded-sm text-indigo-600 hover:underline break-words dark:text-indigo-400 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {label}
          </a>
        ) : (
          label && <span className="text-gray-700 dark:text-gray-300 break-words">{label}</span>
        )}
        {label !== host && host && (
          <span className="min-w-0 text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400">
            {host}
          </span>
        )}
        {facts.length > 0 && (
          <span className="text-gray-500 dark:text-gray-400">
            <Facts facts={facts} />
          </span>
        )}
      </RowLine>
      {item.limitReached && (
        <p className="mt-1 ms-5.5 text-amber-700 dark:text-amber-400">
          {t(
            'toolActivity.pageReadLimit',
            'Page read limit reached for this answer — ask to continue in the next message to read more.'
          )}
        </p>
      )}
      <ItemDetails item={item} show={details} words={page?.read?.words} />
      <ItemError item={item} />
    </li>
  );
}

function ToolRow({ item, stalled, details }) {
  const { t } = useTranslation();
  const facts = rowFacts(t, item);
  return (
    <li>
      <RowLine icon={<StatusIcon item={item} fallback="wrench" />}>
        <ToolLabel item={item} />
        {item.occurrence > 1 && (
          <RowChip className="whitespace-nowrap">{occurrenceLabel(t, item.occurrence)}</RowChip>
        )}
        {facts.length > 0 && (
          <span className="text-gray-500 dark:text-gray-400">
            <Facts facts={facts} />
          </span>
        )}
      </RowLine>
      <ProgressLine item={item} />
      {stalled && <ActivityHint kind="stalled" />}
      <ItemOutcome item={item} />
      <ItemDetails item={item} show={details} />
      <ItemError item={item} />
    </li>
  );
}

/**
 * The name of a plain call: what it makes ("Creating web artifact", "Created
 * web artifact") when the server said so, else its title or id as before.
 */
function ToolLabel({ item }) {
  const { t } = useTranslation();
  const noun = outputNounOf(t, item.outputKind);
  if (noun) {
    return (
      <span className="text-gray-800 dark:text-gray-200">
        {item.status === 'completed'
          ? createdLabel(t, noun)
          : stripEllipsis(creatingLabel(t, noun))}
      </span>
    );
  }
  if (item.status === 'preparing' || item.status === 'awaiting') {
    return (
      <span className="text-gray-800 dark:text-gray-200">
        {stripEllipsis(t('toolActivity.preparingTool', 'Preparing {{name}}…', { name: item.name }))}
      </span>
    );
  }
  if (item.titled || item.started === false) {
    // A titled action reads on its own ("Search people"), and so does a call that
    // never started: "Ran my_tool" would be wrong for it. The id stays in the tooltip.
    return <span className="text-gray-800 dark:text-gray-200">{item.name}</span>;
  }
  return (
    <span>
      {item.status === 'running'
        ? t('toolActivity.runningTool', 'Running {{name}}', { name: item.name })
        : t('toolActivity.ranTool', 'Ran {{name}}', { name: item.name })}
    </span>
  );
}

/**
 * How much the model has written of a call and for how long, under its row:
 * ticking while the arguments are being written, still once they are done, the
 * last reading for a call that stopped or failed first.
 */
function ProgressLine({ item }) {
  const written = item.status === 'preparing';
  const frozen = !item.started && (item.status === 'stopped' || item.status === 'error');
  if (!written && !(frozen && item.elapsedMs > 0)) return null;
  return (
    <p className="mt-1 ms-5.5 tabular-nums text-gray-500 dark:text-gray-400" aria-hidden="true">
      <ArgumentProgress
        argBytes={item.argBytes}
        elapsedMs={item.elapsedMs}
        receivedAt={item.receivedAt}
        running={written && !item.ready}
        suffix={item.ready ? 'readyToRun' : null}
      />
    </p>
  );
}

/**
 * Why a call that never ran ended, as a sentence under its row: cut off,
 * unreadable or refused (red, it failed), or stopped before it was finished or
 * run (gray, the user chose it).
 */
function ItemOutcome({ item }) {
  const { t } = useTranslation();
  if (item.status === 'error') {
    const reason = failureReasonOf(t, item);
    return reason ? (
      <p className="mt-1 ms-5.5 break-words text-red-600 dark:text-red-400">{reason}</p>
    ) : null;
  }
  if (item.status === 'stopped' && !item.started && hasOutputKind(item)) {
    return (
      <p className="mt-1 ms-5.5 break-words text-gray-600 dark:text-gray-400">
        {stoppedUnstartedLabel(t, item)}
      </p>
    );
  }
  return null;
}

/** "1.2 s", in the reader's own number format. */
function formatDuration(ms, language) {
  try {
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(ms / 1000)} s`;
  } catch {
    return `${(ms / 1000).toFixed(1)} s`;
  }
}

/**
 * The plumbing behind a row, only when the Technical details switch is on:
 * the tool, how long it took, and each argument the model passed, by its name,
 * with one chip per value (so every filter of a search reads on its own).
 */
function ItemDetails({ item, show, words = 0 }) {
  const { t, i18n } = useTranslation();
  if (!show) return null;
  const entries = item.details || [];
  const hasDuration = Number.isFinite(item.durationMs) && item.durationMs > 0;
  if (!entries.length && !hasDuration && !item.toolId && !words) return null;
  const chip =
    'm-0 px-1.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono break-all';
  return (
    <dl className="mt-0.5 mb-1 ms-5.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {item.toolId && (
        <div className="inline-flex flex-wrap items-baseline gap-1 min-w-0">
          <dt className="text-gray-500 dark:text-gray-400">{t('toolActivity.detailTool')}</dt>
          <dd className={chip}>{item.toolId}</dd>
        </div>
      )}
      {hasDuration && (
        <div className="inline-flex flex-wrap items-baseline gap-1 min-w-0">
          <dt className="text-gray-500 dark:text-gray-400">{t('toolActivity.detailDuration')}</dt>
          <dd className={chip}>{formatDuration(item.durationMs, i18n?.language)}</dd>
        </div>
      )}
      {words > 0 && (
        <span className="text-gray-500 dark:text-gray-400">
          {t('toolActivity.wordsRead', { count: words })}
        </span>
      )}
      {entries.map(detail => (
        <div key={detail.name} className="inline-flex flex-wrap items-baseline gap-1 min-w-0">
          <dt className="text-gray-500 dark:text-gray-400">{detail.name}</dt>
          {detail.values.map(value => (
            <dd key={value.full ?? value.text} className={chip}>
              {value.full ?? value.text}
            </dd>
          ))}
          {detail.more > 0 && (
            <dd className="m-0 text-gray-500 dark:text-gray-400">
              {t('toolActivity.moreValues', { count: detail.more })}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** Why the call failed, shown under it — the "Failed" label's tooltip is out of reach on touch screens. */
function ItemError({ item }) {
  if (item.status !== 'error' || !item.error) return null;
  return <p className="mt-1 ms-5.5 text-red-600 dark:text-red-400 break-words">{item.error}</p>;
}

/**
 * One hit under a search row: its title (a link when it has a page), then its
 * host, never clipped. No "read" marker: what was opened is a row of its own.
 */
function SourceRow({ source }) {
  const host = source.url ? hostnameOf(source.url) : null;
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      {source.url ? (
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-6 min-w-0 max-w-full items-center rounded-sm text-indigo-600 hover:underline dark:text-indigo-400 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <span className="line-clamp-2 break-words">{source.title || host}</span>
        </a>
      ) : (
        <span className="line-clamp-2 break-words text-gray-700 dark:text-gray-300">
          {source.title || source.ref?.id}
        </span>
      )}
      {source.title && host && (
        <span className="min-w-0 max-w-full text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400">
          {host}
        </span>
      )}
    </li>
  );
}

export default ToolActivity;
