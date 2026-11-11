// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';
import { usePlatformConfig } from '../../../../shared/contexts/platformConfigContextValue';
import AdminLoadError from '../AdminLoadError';
import ConformityDialog from './ConformityDialog';
import ConformityHistory, { formatWho } from './ConformityHistory';

const BTN =
  'inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2';

/** "Nothing was recorded from A to B": the gap between the last off and the enable after it. */
function gapOf(conformity) {
  const [latest, previous] = conformity?.history || [];
  if (!latest?.enabled || !previous || previous.enabled) return null;
  return { from: previous.changedAt, to: latest.changedAt };
}

function Reason({ text }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 280 || text.split('\n').length > 4;
  return (
    <div>
      <p
        data-testid="conformity-reason-text"
        className={`whitespace-pre-wrap break-words ${expanded || !long ? '' : 'line-clamp-4'}`}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-sm font-medium text-indigo-700 dark:text-indigo-300 underline focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
        >
          {expanded
            ? t('admin.euAiAct.master.showLess', 'Show less')
            : t('admin.euAiAct.master.showFull', 'Show full reason')}
        </button>
      )}
    </div>
  );
}

/**
 * The first card of `/admin/eu-ai-act`: the state of the EU AI Act master switch,
 * the Switch off / Switch on again buttons, the record while off (who, when, why)
 * and the history. While off it is an amber banner. No green anywhere: green is for
 * real check results. A permanent notice, not an alert.
 *
 * @param {Object} props
 * @param {Object|null} props.conformity - `status.conformity` (the record)
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onReload
 */
export default function ConformityCard({ conformity, loading, error, onReload }) {
  const { t } = useTranslation();
  const headingId = useId();
  const headingRef = useRef(null);
  const offButtonRef = useRef(null);
  const [dialog, setDialog] = useState(null); // 'off' | 'on' | null
  const [announcement, setAnnouncement] = useState('');
  const [local, setLocal] = useState(null);
  const [focusHeading, setFocusHeading] = useState(false);
  const platform = usePlatformConfig();

  // The record from the answer wins until the next status load replaces it.
  const record = local || conformity;
  useEffect(() => {
    setLocal(null);
  }, [conformity]);
  useEffect(() => {
    if (focusHeading) {
      headingRef.current?.focus();
      setFocusHeading(false);
    }
  }, [focusHeading, record]);

  const done = (next, mode) => {
    setLocal(next);
    setDialog(null);
    setFocusHeading(true);
    setAnnouncement(
      mode === 'off'
        ? t(
            'admin.euAiAct.master.savedOff',
            'EU AI Act features switched off. Recorded for {{name}}.',
            {
              name: formatWho(next.changedBy)
            }
          )
        : t('admin.euAiAct.master.savedOn', 'EU AI Act features switched on.')
    );
    onReload();
    // The nav badge and the notes on the other admin pages read the public config.
    void platform?.refreshConfig?.();
  };

  const off = record && record.enabled === false;
  const gap = !off ? gapOf(record) : null;
  const shell =
    'scroll-mt-4 rounded-lg shadow-xs border overflow-hidden bg-white dark:bg-gray-800 ' +
    (off
      ? 'border-gray-200 dark:border-gray-700 border-l-4 border-l-amber-500 dark:border-l-amber-400'
      : 'border-gray-200 dark:border-gray-700');

  return (
    <section
      id="conformity"
      data-testid="conformity-card"
      aria-labelledby={headingId}
      aria-busy={loading}
      className={shell}
    >
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {loading && !record ? (
        <div className="p-6" aria-busy="true">
          <span className="sr-only">{t('admin.euAiAct.master.loading', 'Loading status')}</span>
          <h2 id={headingId} className="sr-only">
            {t('admin.euAiAct.master.title', 'EU AI Act features')}
          </h2>
          <div
            aria-hidden="true"
            className="h-5 w-1/3 bg-gray-200 dark:bg-gray-700 rounded-sm animate-pulse motion-reduce:animate-none"
          />
        </div>
      ) : !record ? (
        <div className="p-6">
          <h2 id={headingId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.euAiAct.master.title', 'EU AI Act features')}
          </h2>
          <Badge tone="neutral" className="mt-2">
            {t('admin.euAiAct.master.unknown', 'Status unknown')}
          </Badge>
          <AdminLoadError
            framed={false}
            message={error || ''}
            title={t('admin.euAiAct.master.loadError', 'Could not load the switch status')}
            action={{ label: t('common.retry', 'Retry'), onClick: () => onReload() }}
          />
        </div>
      ) : off ? (
        <div data-testid="conformity-state" data-state="off">
          <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4 bg-amber-50 dark:bg-amber-900/20">
            <div className="flex items-start gap-3 min-w-0">
              <Icon
                name="exclamation-triangle"
                size="lg"
                className="shrink-0 text-amber-700 dark:text-amber-300"
              />
              <h2
                id={headingId}
                ref={headingRef}
                tabIndex={-1}
                className="text-lg font-semibold text-amber-900 dark:text-amber-100 focus:outline-hidden"
              >
                {t('admin.euAiAct.master.offTitle', 'EU AI Act features are switched off')}
              </h2>
            </div>
            <Badge tone="warning" icon={<Icon name="exclamation-triangle" size="sm" />}>
              {t('admin.euAiAct.master.off', 'Switched off')}
            </Badge>
          </div>
          <div className="px-6 py-4 space-y-4 text-sm text-gray-900 dark:text-gray-100">
            <p className="text-gray-700 dark:text-gray-300">
              {t(
                'admin.euAiAct.master.offText',
                'No guardrail, notice, acknowledgement, record, marking or verification is applied. Existing data is kept.'
              )}
            </p>
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[7rem_1fr]">
              <dt className="font-medium">{t('admin.euAiAct.master.by', 'Switched off by')}</dt>
              <dd data-testid="conformity-who">{formatWho(record.changedBy)}</dd>
              <dt className="font-medium">{t('admin.euAiAct.master.when', 'When')}</dt>
              <dd>
                <time dateTime={record.changedAt} title={record.changedAt}>
                  {new Date(record.changedAt).toLocaleString()}
                </time>
              </dd>
              <dt className="font-medium">{t('admin.euAiAct.master.reason', 'Reason')}</dt>
              <dd>
                <Reason text={record.reason || ''} />
              </dd>
            </dl>
            {/* [LEGAL] draft wording: needs legal review, not legal advice. */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-900 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-100 flex gap-3">
              <Icon name="information-circle" size="md" className="shrink-0 mt-0.5" />
              <p>
                {t(
                  'admin.euAiAct.master.legal',
                  "Switching off does not remove your organisation's obligations under the EU AI Act. The duty stays with you as the deployer. This is not legal advice."
                )}
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={() => setDialog('on')}
                className={`${BTN} bg-indigo-600 text-white hover:bg-indigo-700`}
              >
                {t('admin.euAiAct.master.btnOn', 'Switch on again...')}
              </button>
            </div>
            <ConformityHistory history={record.history} />
          </div>
        </div>
      ) : (
        <div data-testid="conformity-state" data-state="on">
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
            <div className="flex flex-wrap items-center gap-3 min-w-0">
              <h2
                id={headingId}
                ref={headingRef}
                tabIndex={-1}
                className="text-lg font-semibold text-gray-900 dark:text-gray-100 focus:outline-hidden"
              >
                {t('admin.euAiAct.master.title', 'EU AI Act features')}
              </h2>
              <Badge tone="info" icon={<Icon name="shield-check" size="sm" />}>
                {t('admin.euAiAct.master.on', 'On')}
              </Badge>
            </div>
            <button
              type="button"
              ref={offButtonRef}
              onClick={() => setDialog('off')}
              className={`${BTN} border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 bg-white dark:bg-gray-800 hover:bg-red-50 dark:hover:bg-red-900/20`}
            >
              {t('admin.euAiAct.master.btnOff', 'Switch off...')}
            </button>
          </div>
          <div className="px-6 pb-4 text-sm">
            <p className="text-gray-700 dark:text-gray-300">
              {t(
                'admin.euAiAct.master.onText',
                'All EU AI Act features are active as configured below.'
              )}
            </p>
            {record.valid === false && (
              <p
                className="mt-2 text-amber-900 dark:text-amber-100"
                data-testid="conformity-invalid"
              >
                {t(
                  'admin.euAiAct.master.invalid',
                  'The stored record is incomplete, so the features stay on. Switch them off again to record who and why.'
                )}
              </p>
            )}
            {gap && (
              <p className="mt-2 text-gray-700 dark:text-gray-300" data-testid="conformity-gap">
                {t(
                  'admin.euAiAct.master.gap',
                  'Nothing was recorded or marked from {{from}} to {{to}}.',
                  {
                    from: new Date(gap.from).toLocaleString(),
                    to: new Date(gap.to).toLocaleString()
                  }
                )}
              </p>
            )}
            <ConformityHistory history={record.history} />
          </div>
        </div>
      )}
      {dialog && (
        <ConformityDialog
          key={dialog}
          mode={dialog}
          isOpen
          onClose={() => setDialog(null)}
          onDone={done}
          onReload={onReload}
        />
      )}
    </section>
  );
}
