import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { fetchDetectionLog } from './tabsApi';
import { extractApiError, formatBytes, formatDateTime } from './fileHelpers';
import { DETECTION_LOG_LIMIT, describeRequester, shortenHash, verdictTone } from './detectionModel';
import { requesterTypeLabel, techniqueLabel, verdictLabel } from './detectionLabels';
import { Button, LoadingRow, Notice, SectionCard, StatusPill, TABLE } from './EuAiActUi';

/**
 * "Detection log" panel of the Detection tab (CoP 2.1.3): the latest
 * verifications with metadata only — time, requester, content hash, kind,
 * verdict and the techniques that found a mark. The submitted content is
 * never stored.
 *
 * @param {Object} props
 * @param {boolean} [props.logEnabled=true] - `settings.detection.log.enabled`
 * @param {number} [props.retentionDays] - `settings.detection.log.retentionDays`
 */
function DetectionLogPanel({ logEnabled = true, retentionDays }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [entries, setEntries] = useState([]);
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchDetectionLog(DETECTION_LOG_LIMIT);
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
      setLoadError('');
      setLoadState('ready');
    } catch (err) {
      setLoadError(extractApiError(err).message);
      setLoadState(prev => (prev === 'ready' ? 'ready' : 'error'));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  let retentionText = null;
  if (typeof retentionDays === 'number') {
    retentionText =
      retentionDays > 0
        ? t('admin.euAiAct.detection.log.retention', 'Entries are deleted after {{days}} days.', {
            days: retentionDays
          })
        : t('admin.euAiAct.detection.log.retentionKeep', 'Entries are kept until deleted.');
  }

  return (
    <SectionCard
      id="eu-detect-log"
      title={t('admin.euAiAct.detection.log.title', 'Detection log')}
      description={t(
        'admin.euAiAct.detection.log.description',
        'The latest {{limit}} checks of this installation.',
        { limit: DETECTION_LOG_LIMIT }
      )}
      actions={
        <Button icon={ArrowPathIcon} busy={refreshing} onClick={load}>
          {t('admin.euAiAct.detection.log.refresh', 'Refresh')}
        </Button>
      }
    >
      <Notice
        tone="success"
        title={t(
          'admin.euAiAct.detection.log.zeroRetention',
          'No submitted content is stored (zero retention, CoP 2.1.3).'
        )}
      >
        <p>
          {t(
            'admin.euAiAct.detection.log.zeroRetentionBody',
            'The log keeps metadata only: time, requester, content hash, kind, verdict and techniques.'
          )}{' '}
          {retentionText}
        </p>
      </Notice>

      {!logEnabled && (
        <Notice
          tone="info"
          title={t(
            'admin.euAiAct.detection.log.disabled',
            'The detection log is switched off. New checks are not recorded.'
          )}
        />
      )}

      {loadState === 'loading' && (
        <LoadingRow
          label={t('admin.euAiAct.detection.log.loading', 'Loading the detection log…')}
        />
      )}
      {loadError && (
        <Notice
          tone={loadState === 'ready' ? 'warning' : 'error'}
          role="alert"
          title={t(
            'admin.euAiAct.detection.log.loadError',
            'The detection log could not be loaded.'
          )}
        >
          <p>{loadError}</p>
        </Notice>
      )}

      {loadState === 'ready' && (
        <div className={TABLE.wrapper}>
          <table className={TABLE.table}>
            <caption className="sr-only">
              {t('admin.euAiAct.detection.log.caption', 'Latest detection checks')}
            </caption>
            <thead className={TABLE.thead}>
              <tr>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.log.colTime', 'Time')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.log.colRequester', 'Requester')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.log.colHash', 'Content hash')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.log.colKind', 'Kind')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.log.colVerdict', 'Verdict')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.log.colTechniques', 'Techniques')}
                </th>
              </tr>
            </thead>
            <tbody className={TABLE.tbody}>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={6} className={TABLE.empty}>
                    {t('admin.euAiAct.detection.log.empty', 'No checks recorded yet.')}
                  </td>
                </tr>
              )}
              {entries.map(entry => {
                const requester = describeRequester(entry.requester);
                const techniques = Array.isArray(entry.techniques) ? entry.techniques : [];
                return (
                  <tr key={entry.id} className={TABLE.tr}>
                    <td className={`${TABLE.td} whitespace-nowrap`}>
                      {formatDateTime(entry.at, locale)}
                      {typeof entry.durationMs === 'number' && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {t('admin.euAiAct.detection.log.duration', '{{ms}} ms', {
                            ms: entry.durationMs
                          })}
                        </div>
                      )}
                    </td>
                    <td className={TABLE.td}>
                      <div>{requesterTypeLabel(t, requester.type)}</div>
                      {requester.id && (
                        <div className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">
                          {requester.id}
                        </div>
                      )}
                    </td>
                    <td className={TABLE.tdMono} title={entry.contentHash || undefined}>
                      {shortenHash(entry.contentHash)}
                    </td>
                    <td className={TABLE.td}>
                      <div>{entry.kind || '—'}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {[entry.mimeType, formatBytes(entry.size, locale)]
                          .filter(value => value && value !== '—')
                          .join(' · ')}
                      </div>
                    </td>
                    <td className={TABLE.td}>
                      <StatusPill tone={verdictTone(entry.verdict)}>
                        {verdictLabel(t, entry.verdict)}
                      </StatusPill>
                    </td>
                    <td className={TABLE.td}>
                      {techniques.length > 0
                        ? techniques.map(name => techniqueLabel(t, name)).join(', ')
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

export default DetectionLogPanel;
