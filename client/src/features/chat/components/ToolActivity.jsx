// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { hostnameOf } from '../../../../../shared/run/groundingSources.js';
import {
  awaitingApprovalLabel,
  createdLabel,
  creatingLabel,
  failedLabel,
  failureReasonOf,
  hasOutputKind,
  headlineOf,
  idleLabel,
  isActiveItem,
  occurrenceLabel,
  outputGlyphOf,
  outputNounOf,
  stoppedLabel,
  stoppedUnstartedLabel,
  stripEllipsis,
  summaryIconOf
} from '../activityHeadline.js';
import { isStalled } from '../activityTiming.js';
import { ActivityHint, ArgumentProgress, BusyIcon, RowChip, useNow } from './ActivityProgress';

/** Colour of the label of a call or status that is active right now. */
const ACTIVE_LABEL = 'font-medium text-gray-800 dark:text-gray-200';
const ATTENTION = 'text-amber-700 dark:text-amber-400';

/**
 * What the turn is doing and did: the searches it ran (web or the
 * organisation's documents), the pages or documents they found and which of
 * those were read, the other tools it called, the files it is writing, and,
 * when it has nothing else to show, that the model is still working.
 *
 * Open while the answer streams, so the user can follow the turn as it
 * happens; collapsed to a one-line summary once the answer is complete, where
 * it stays as provenance. The one-line headline always carries the current
 * status, so a list the user closed does not hide it.
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
  // null = follow the streaming state; a click pins the user's choice.
  const [expanded, setExpanded] = useState(null);

  const items = activity?.items || [];
  // The silence of a model call belongs to a turn that is still going.
  const idle = loading ? activity?.idle || null : null;
  const anyActive = items.some(item => isActiveItem(item)) || Boolean(idle);
  // The clock only runs while something is going on.
  const now = useNow(anyActive);

  if (items.length === 0) return idle ? <IdleLine idle={idle} /> : null;
  const open = expanded ?? loading;
  const headline = headlineOf(t, activity, loading);
  const owner = headline.owner;

  return (
    <div aria-live="off" className="mb-2 text-xs text-gray-600 dark:text-gray-400">
      <button
        type="button"
        onClick={() => setExpanded(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className="group inline-flex items-center gap-1.5 max-w-full py-1 -my-1 rounded-sm text-start hover:text-gray-900 dark:hover:text-gray-200 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <HeadlineIcon headline={headline} items={items} idle={idle} />
        <span
          title={headline.label}
          className={`min-w-0 truncate ${
            headline.active
              ? `${ACTIVE_LABEL} group-hover:text-gray-900 dark:group-hover:text-gray-100`
              : ''
          }`}
        >
          {headline.label}
        </span>
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
      {open && (
        <ol
          id={listId}
          aria-busy={anyActive}
          className="mt-1.5 ms-1.5 ps-3 border-s border-gray-200 dark:border-gray-700 space-y-2"
        >
          {items.map(item => (
            <ActivityItem key={item.id} item={item} stalled={isStalled(item, now)} />
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

/** The icon in front of the headline: a spinner while it is busy, else what the line stands for. */
function HeadlineIcon({ headline, items, idle }) {
  if (headline.busy) {
    return <BusyIcon staticIcon={headline.mode === 'idle' ? idleIcon(idle.kind) : 'clock'} />;
  }
  if (headline.mode === 'awaiting') {
    return <Icon name="shield-check" size="sm" className={`shrink-0 ${ATTENTION}`} />;
  }
  if (headline.mode === 'preparing') {
    // Arguments complete, a parallel call is still being written: nothing moves here.
    return <Icon name="clock" size="sm" className="shrink-0 text-gray-500 dark:text-gray-400" />;
  }
  const icon = summaryIconOf(items);
  return (
    <Icon
      name={icon.name}
      size="sm"
      className={`shrink-0 ${icon.failed ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}
    />
  );
}

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
      name={outputGlyphOf(item, fallback)}
      size="sm"
      className="shrink-0 text-gray-500 dark:text-gray-400"
    />
  );
}

function ActivityItem({ item, stalled = false }) {
  if (item.kind === 'skill') return <SkillRow item={item} />;
  // A call whose arguments were never seen to start (still being written,
  // waiting for approval, stopped or refused first) knows no query or page yet:
  // it reads as a plain call, whatever the server said it is.
  const unstarted = item.started === false;
  if (item.kind === 'search' && !unstarted) return <SearchRow item={item} />;
  if (item.kind === 'fetch' && !unstarted) return <FetchRow item={item} />;
  return <ToolRow item={item} stalled={stalled} />;
}

function SkillRow({ item }) {
  const { t } = useTranslation();
  return (
    <li>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusIcon item={item} fallback="sparkles" />
        <span>{t('toolActivity.usedSkill', 'Used skill')}</span>
        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-700/50">
          {item.name}
        </span>
        {item.activatedBy === 'user' && (
          <span className="text-gray-500 dark:text-gray-400">
            {t('toolActivity.skillByUser', 'started by you')}
          </span>
        )}
        {item.activatedBy === 'model' && (
          <span className="text-gray-500 dark:text-gray-400">
            {t('toolActivity.skillByModel', 'loaded by the model')}
          </span>
        )}
      </div>
    </li>
  );
}

/** The queries a search row shows: a provider-run search lists its own, a tool call has one. */
function queriesOf(item) {
  if (item.native) return item.queries;
  return item.query ? [item.query] : [];
}

function SearchRow({ item }) {
  const { t } = useTranslation();
  const queries = queriesOf(item);
  return (
    <li>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusIcon item={item} fallback="search" />
        <span>
          {queries.length
            ? t('toolActivity.searchedFor', 'Searched for')
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
        {item.sources.length > 0 && (
          <span className="text-gray-500 dark:text-gray-400">
            {t('toolActivity.results', { count: item.sources.length })}
          </span>
        )}
        <IntegrationChip item={item} />
        <ItemStatus item={item} />
      </div>
      <ItemDetails item={item} />
      <ItemError item={item} />
      {item.sources.length > 0 && (
        <ul className="mt-1 ms-5 space-y-0.5">
          {item.sources.map(source => (
            <SourceRow key={source.id} source={source} />
          ))}
        </ul>
      )}
    </li>
  );
}

function FetchRow({ item }) {
  const { t } = useTranslation();
  const page = item.sources[0];
  const url = item.url || page?.url;
  const host = url ? hostnameOf(url) : null;
  const label = page?.title || item.title || host || item.documentId;
  return (
    <li>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusIcon item={item} fallback="document-text" />
        <span>
          {item.limitReached
            ? t('toolActivity.notRead', 'Not read')
            : t('toolActivity.readPage', 'Read')}
        </span>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 dark:text-indigo-400 hover:underline break-all"
            title={url}
          >
            {label}
          </a>
        ) : (
          label && <span className="text-gray-700 dark:text-gray-300 break-all">{label}</span>
        )}
        {label !== host && host && <span className="text-gray-500 dark:text-gray-400">{host}</span>}
        {page?.read?.words > 0 && (
          <span className="text-gray-500 dark:text-gray-400">
            {t('toolActivity.wordsRead', { count: page.read.words })}
          </span>
        )}
        {page?.read?.truncated && (
          <span
            className="text-amber-700 dark:text-amber-400"
            title={t('toolActivity.truncatedTitle', 'The page is longer than what was read')}
          >
            {t('toolActivity.truncated', 'truncated')}
          </span>
        )}
        <ItemStatus item={item} />
      </div>
      {item.limitReached && (
        <p className="mt-1 ms-5 text-amber-700 dark:text-amber-400">
          {t(
            'toolActivity.pageReadLimit',
            'Page read limit reached for this answer — ask to continue in the next message to read more.'
          )}
        </p>
      )}
      <ItemDetails item={item} />
      <ItemError item={item} />
    </li>
  );
}

function ToolRow({ item, stalled }) {
  const { t } = useTranslation();
  return (
    <li>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusIcon item={item} fallback="wrench" />
        <ToolLabel item={item} />
        {item.occurrence > 1 && (
          <RowChip className="whitespace-nowrap">{occurrenceLabel(t, item.occurrence)}</RowChip>
        )}
        <IntegrationChip item={item} />
        <ItemStatus item={item} />
      </div>
      <ProgressLine item={item} />
      {stalled && <ActivityHint kind="stalled" />}
      <ItemOutcome item={item} />
      <ItemDetails item={item} />
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
      <span className="text-gray-800 dark:text-gray-200" title={item.toolId}>
        {item.status === 'completed'
          ? createdLabel(t, noun)
          : stripEllipsis(creatingLabel(t, noun))}
      </span>
    );
  }
  if (item.status === 'preparing' || item.status === 'awaiting') {
    return (
      <span className="text-gray-800 dark:text-gray-200" title={item.toolId}>
        {stripEllipsis(t('toolActivity.preparingTool', 'Preparing {{name}}…', { name: item.name }))}
      </span>
    );
  }
  if (item.titled || item.started === false) {
    // A titled action reads on its own ("Search people"), and so does a call that
    // never started: "Ran my_tool" would be wrong for it. The id stays in the tooltip.
    return (
      <span className="text-gray-800 dark:text-gray-200" title={item.toolId}>
        {item.name}
      </span>
    );
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
    <p className="mt-1 ms-5 tabular-nums text-gray-500 dark:text-gray-400" aria-hidden="true">
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
      <p className="mt-1 ms-5 break-words text-red-600 dark:text-red-400">{reason}</p>
    ) : null;
  }
  if (item.status === 'stopped' && !item.started && hasOutputKind(item)) {
    return (
      <p className="mt-1 ms-5 break-words text-gray-600 dark:text-gray-400">
        {stoppedUnstartedLabel(t, item)}
      </p>
    );
  }
  return null;
}

/** The integration, MCP server or remote agent the call ran against. */
function IntegrationChip({ item }) {
  const { t } = useTranslation();
  if (!item.integration) return null;
  return (
    <RowChip
      title={t('toolActivity.integrationTitle', 'Data from {{name}}', { name: item.integration })}
    >
      <Icon name="link" size="xs" className="shrink-0" />
      {item.integration}
    </RowChip>
  );
}

/**
 * What the call asked for: each argument the model passed, by its name, with
 * one chip per value (so every filter of a search reads on its own).
 */
function ItemDetails({ item }) {
  const { t } = useTranslation();
  if (!item.details?.length) return null;
  return (
    <dl className="mt-1 ms-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {item.details.map(detail => (
        <div key={detail.name} className="inline-flex flex-wrap items-baseline gap-1 min-w-0">
          <dt className="text-gray-500 dark:text-gray-400">{detail.name}</dt>
          {detail.values.map(value => (
            <dd
              key={value.full ?? value.text}
              className="m-0 px-1.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono break-all"
              title={value.full}
            >
              {value.text}
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
  return (
    <p
      className="mt-1 ms-5 text-red-600 dark:text-red-400 break-words line-clamp-3"
      title={item.error}
    >
      {item.error}
    </p>
  );
}

function ItemStatus({ item }) {
  const { t } = useTranslation();
  if (item.status === 'error') {
    return (
      <span className="text-red-600 dark:text-red-400" title={item.error || undefined}>
        {failedLabel(t)}
      </span>
    );
  }
  if (item.status === 'awaiting') {
    return <span>{awaitingApprovalLabel(t)}</span>;
  }
  // A file stopped before it was run says why in its own sentence, which starts with "Stopped".
  if (item.status === 'stopped' && !(!item.started && hasOutputKind(item))) {
    return <span>{stoppedLabel(t)}</span>;
  }
  return null;
}

function SourceRow({ source }) {
  const { t } = useTranslation();
  const host = source.url ? hostnameOf(source.url) : null;
  return (
    <li className="flex items-baseline gap-1.5 min-w-0">
      {source.url ? (
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-600 dark:text-indigo-400 hover:underline truncate"
          title={source.url}
        >
          {source.title || host}
        </a>
      ) : (
        <span className="text-gray-700 dark:text-gray-300 truncate">
          {source.title || source.ref?.id}
        </span>
      )}
      {source.title && host && (
        <span className="shrink-0 text-gray-500 dark:text-gray-400">{host}</span>
      )}
      {source.read?.ok && (
        <span
          className="shrink-0 inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400"
          title={
            source.kind === 'document'
              ? t('toolActivity.readDocumentTitle', 'The document was read')
              : t('toolActivity.readTitle', 'The page was fetched and read')
          }
        >
          <Icon name="eye" size="xs" />
          {t('toolActivity.read', 'Read')}
        </span>
      )}
      {source.read?.ok === false && (
        <span
          className="shrink-0 text-amber-700 dark:text-amber-400"
          title={t('toolActivity.readFailedTitle', 'The page could not be fetched')}
        >
          {t('toolActivity.readFailed', 'Not readable')}
        </span>
      )}
    </li>
  );
}

export default ToolActivity;
