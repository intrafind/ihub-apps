import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BeakerIcon, PlayIcon } from '@heroicons/react/24/outline';
import { fetchBenchmark, runBenchmark } from './tabsApi';
import { extractApiError, formatDateTime, formatPercent } from './fileHelpers';
import { benchmarkStatusTone } from './detectionModel';
import { techniqueLabel } from './detectionLabels';
import {
  Button,
  DefinitionList,
  LoadingRow,
  Notice,
  SectionCard,
  Spinner,
  StatusPill,
  TABLE
} from './EuAiActUi';

/**
 * "Self-test / robustness benchmark" panel of the Detection tab: shows the
 * latest report (true/false positive rates per technique and transform)
 * and runs the quick self-test or the full benchmark, which can take
 * several minutes. Both run buttons are disabled while a run is active.
 *
 * @param {Object} props
 * @param {() => void} [props.onChanged] - Called after a run (refreshes the page status)
 */
function DetectionBenchmarkPanel({ onChanged }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [report, setReport] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [running, setRunning] = useState(null);
  const [runError, setRunError] = useState('');
  const [runMessage, setRunMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await fetchBenchmark();
      setReport(data?.report || null);
      setLoadError('');
      setLoadState('ready');
    } catch (err) {
      setLoadError(extractApiError(err).message);
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRun = async quick => {
    setRunning(quick ? 'quick' : 'full');
    setRunError('');
    setRunMessage('');
    try {
      const data = await runBenchmark(quick);
      const next = data?.report || null;
      setReport(next);
      setLoadState('ready');
      setRunMessage(
        t(
          'admin.euAiAct.detection.benchmark.finished',
          'Run finished: {{passed}} of {{total}} checks passed, {{failed}} failed, {{skipped}} skipped.',
          {
            passed: next?.summary?.passed ?? 0,
            total: next?.summary?.total ?? 0,
            failed: next?.summary?.failed ?? 0,
            skipped: next?.summary?.skipped ?? 0
          }
        )
      );
      onChanged?.();
    } catch (err) {
      setRunError(extractApiError(err).message);
    } finally {
      setRunning(null);
    }
  };

  const statusText = status => {
    switch (status) {
      case 'pass':
        return t('admin.euAiAct.detection.benchmark.statusPass', 'Pass');
      case 'fail':
        return t('admin.euAiAct.detection.benchmark.statusFail', 'Fail');
      case 'skipped':
        return t('admin.euAiAct.detection.benchmark.statusSkipped', 'Skipped');
      default:
        return status || '—';
    }
  };

  const results = Array.isArray(report?.results) ? report.results : [];
  const summary = report?.summary || null;
  const environmentItems = Object.entries(report?.environment || {})
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => ({ label: key, value: String(value) }));

  return (
    <SectionCard
      id="eu-detect-benchmark"
      title={t('admin.euAiAct.detection.benchmark.title', 'Self-test and robustness benchmark')}
      description={t(
        'admin.euAiAct.detection.benchmark.description',
        'Marks sample content with the current configuration, applies common transformations (for example re-compression, resizing, cropping or copying text) and measures how often each technique still finds the mark (TPR) and how often it wrongly reports one (FPR). The results go into the compliance report.'
      )}
      actions={
        <>
          <Button
            icon={PlayIcon}
            busy={running === 'quick'}
            disabled={running !== null}
            onClick={() => handleRun(true)}
          >
            {t('admin.euAiAct.detection.benchmark.runQuick', 'Run self-test')}
          </Button>
          <Button
            icon={BeakerIcon}
            busy={running === 'full'}
            disabled={running !== null}
            onClick={() => handleRun(false)}
            aria-describedby="eu-benchmark-full-hint"
          >
            {t('admin.euAiAct.detection.benchmark.runFull', 'Run full benchmark')}
          </Button>
        </>
      }
    >
      <p id="eu-benchmark-full-hint" className="text-xs text-gray-500 dark:text-gray-400">
        {t(
          'admin.euAiAct.detection.benchmark.fullHint',
          'The full benchmark can take several minutes. Keep this page open until it finishes.'
        )}
      </p>

      <div aria-live="polite" className="space-y-3">
        {running && (
          <div className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
            <Spinner />
            <span>
              {running === 'full'
                ? t(
                    'admin.euAiAct.detection.benchmark.runningFull',
                    'Running the full benchmark… This can take several minutes.'
                  )
                : t('admin.euAiAct.detection.benchmark.runningQuick', 'Running the self-test…')}
            </span>
          </div>
        )}
        {!running && runMessage && <Notice tone="success" title={runMessage} />}
        {!running && runError && (
          <Notice
            tone="error"
            title={t('admin.euAiAct.detection.benchmark.runError', 'The run failed: {{error}}', {
              error: runError
            })}
          />
        )}
      </div>

      {loadState === 'loading' && (
        <LoadingRow
          label={t('admin.euAiAct.detection.benchmark.loading', 'Loading the latest report…')}
        />
      )}
      {loadState === 'error' && (
        <Notice
          tone="error"
          role="alert"
          title={t(
            'admin.euAiAct.detection.benchmark.loadError',
            'The latest report could not be loaded.'
          )}
        >
          {loadError && <p>{loadError}</p>}
        </Notice>
      )}

      {loadState === 'ready' && !report && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('admin.euAiAct.detection.benchmark.none', 'No self-test or benchmark has run yet.')}
        </p>
      )}

      {report && (
        <div className="space-y-5">
          <DefinitionList
            items={[
              {
                label: t('admin.euAiAct.detection.benchmark.type', 'Type'),
                value: report.quick
                  ? t('admin.euAiAct.detection.benchmark.typeQuick', 'Self-test')
                  : t('admin.euAiAct.detection.benchmark.typeFull', 'Full benchmark')
              },
              {
                label: t('admin.euAiAct.detection.benchmark.finishedAt', 'Finished'),
                value: formatDateTime(report.finishedAt || report.startedAt, locale)
              },
              {
                label: t('admin.euAiAct.detection.benchmark.trigger', 'Started by'),
                value: report.trigger || '—'
              },
              {
                label: t('admin.euAiAct.detection.benchmark.summary', 'Summary'),
                value: summary ? (
                  <span className="inline-flex flex-wrap gap-2">
                    <StatusPill tone="success">
                      {t('admin.euAiAct.detection.benchmark.passed', '{{number}} passed', {
                        number: summary.passed ?? 0
                      })}
                    </StatusPill>
                    <StatusPill tone={summary.failed > 0 ? 'error' : 'neutral'}>
                      {t('admin.euAiAct.detection.benchmark.failed', '{{number}} failed', {
                        number: summary.failed ?? 0
                      })}
                    </StatusPill>
                    <StatusPill tone="neutral">
                      {t('admin.euAiAct.detection.benchmark.skipped', '{{number}} skipped', {
                        number: summary.skipped ?? 0
                      })}
                    </StatusPill>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {t('admin.euAiAct.detection.benchmark.total', 'of {{number}}', {
                        number: summary.total ?? 0
                      })}
                    </span>
                  </span>
                ) : (
                  '—'
                )
              }
            ]}
          />

          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <caption className="sr-only">
                {t(
                  'admin.euAiAct.detection.benchmark.caption',
                  'Benchmark results per technique and transformation'
                )}
              </caption>
              <thead className={TABLE.thead}>
                <tr>
                  <th scope="col" className={TABLE.th}>
                    {t('admin.euAiAct.detection.benchmark.colTechnique', 'Technique')}
                  </th>
                  <th scope="col" className={TABLE.th}>
                    {t('admin.euAiAct.detection.benchmark.colTransform', 'Transformation')}
                  </th>
                  <th scope="col" className={TABLE.thRight}>
                    {t('admin.euAiAct.detection.benchmark.colSamples', 'Samples')}
                  </th>
                  <th scope="col" className={TABLE.thRight}>
                    {t('admin.euAiAct.detection.benchmark.colDetected', 'Detected')}
                  </th>
                  <th scope="col" className={TABLE.thRight}>
                    <abbr
                      title={t('admin.euAiAct.detection.benchmark.tprLong', 'True positive rate')}
                      className="no-underline"
                    >
                      {t('admin.euAiAct.detection.benchmark.colTpr', 'TPR')}
                    </abbr>
                  </th>
                  <th scope="col" className={TABLE.thRight}>
                    <abbr
                      title={t('admin.euAiAct.detection.benchmark.fprLong', 'False positive rate')}
                      className="no-underline"
                    >
                      {t('admin.euAiAct.detection.benchmark.colFpr', 'FPR')}
                    </abbr>
                  </th>
                  <th scope="col" className={TABLE.th}>
                    {t('admin.euAiAct.detection.benchmark.colStatus', 'Status')}
                  </th>
                </tr>
              </thead>
              <tbody className={TABLE.tbody}>
                {results.length === 0 && (
                  <tr>
                    <td colSpan={7} className={TABLE.empty}>
                      {t(
                        'admin.euAiAct.detection.benchmark.noResults',
                        'The report has no results.'
                      )}
                    </td>
                  </tr>
                )}
                {results.map(row => (
                  <tr key={`${row.technique}-${row.transform}`} className={TABLE.tr}>
                    <td className={TABLE.td}>{techniqueLabel(t, row.technique)}</td>
                    <td className={`${TABLE.td} font-mono text-xs`}>{row.transform || '—'}</td>
                    <td className={`${TABLE.td} text-right tabular-nums`}>{row.samples ?? '—'}</td>
                    <td className={`${TABLE.td} text-right tabular-nums`}>{row.detected ?? '—'}</td>
                    <td className={`${TABLE.td} text-right tabular-nums`}>
                      {formatPercent(row.tpr, locale)}
                    </td>
                    <td className={`${TABLE.td} text-right tabular-nums`}>
                      {formatPercent(row.fpr, locale)}
                    </td>
                    <td className={TABLE.td}>
                      <StatusPill tone={benchmarkStatusTone(row.status)}>
                        {statusText(row.status)}
                      </StatusPill>
                      {row.note && (
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 break-words">
                          {row.note}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {environmentItems.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-gray-700 dark:text-gray-300 font-medium">
                {t('admin.euAiAct.detection.benchmark.environment', 'Test environment')}
              </summary>
              <div className="mt-3">
                <DefinitionList items={environmentItems} />
              </div>
            </details>
          )}
        </div>
      )}
    </SectionCard>
  );
}

export default DetectionBenchmarkPanel;
