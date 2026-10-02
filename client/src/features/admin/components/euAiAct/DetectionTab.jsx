import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowPathIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import { fetchTransparencySettings } from './tabsApi';
import { extractApiError } from './fileHelpers';
import { accessLevelText } from './detectionLabels';
import DetectionTestPanel from './DetectionTestPanel';
import DetectionExpertsPanel from './DetectionExpertsPanel';
import DetectionKeyGroupsPanel from './DetectionKeyGroupsPanel';
import DetectionLogPanel from './DetectionLogPanel';
import DetectionBenchmarkPanel from './DetectionBenchmarkPanel';
import { Button, DefinitionList, Notice, SectionCard, StatusPill } from './EuAiActUi';

/** In-page link to the Settings tab of the EU AI Act page. */
function SettingsLink({ children }) {
  return (
    <Link
      to={{ search: '?tab=settings' }}
      className="text-sm font-medium text-indigo-600 dark:text-indigo-400 underline hover:no-underline"
    >
      {children}
    </Link>
  );
}

/**
 * Detection tab of the EU AI Act admin page (`/admin/eu-ai-act?tab=detection`,
 * concept §8.4).
 *
 * Sections, top to bottom:
 * 1. Test detection — upload/paste content, same detector as `/verify`.
 * 2. Access — who may use the detector, rate limit, log, zero retention
 *    (read-only here; edited on the Settings tab).
 * 3. Approved experts — for free-form text watermark detection (CoP 2.1.2).
 * 4. Text watermark key groups — keys, rotation, vLLM config, bundles.
 * 5. Trusted anchors — count, edited on the Settings tab.
 * 6. Detection log — metadata only.
 * 7. Self-test / robustness benchmark.
 *
 * The tab loads the settings once (experts, access, rate limit, log) and
 * reloads them after an expert change; every other panel loads its own data.
 *
 * @param {Object} props
 * @param {Object} [props.status] - `GET /admin/ai-transparency/status` payload
 *   (fallback for access and trusted-anchor count while settings load)
 * @param {() => void} [props.reload] - Refetches the status after a change
 */
function DetectionTab({ status, reload }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [settingsState, setSettingsState] = useState('loading');
  const [settingsError, setSettingsError] = useState('');

  const loadSettings = useCallback(async () => {
    try {
      const data = await fetchTransparencySettings();
      setSettings(data?.settings || null);
      setSettingsError('');
      setSettingsState('ready');
    } catch (err) {
      setSettingsError(extractApiError(err).message);
      setSettingsState('error');
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleExpertsChanged = async () => {
    await loadSettings();
    reload?.();
  };

  const detection = settings?.detection || status?.settings?.detection || {};
  const access = accessLevelText(t, detection.access);
  const rateLimit = detection.rateLimit;
  const logSettings = detection.log;
  const experts = Array.isArray(settings?.detection?.experts) ? settings.detection.experts : [];
  /** "On, kept for N days" / "On, kept until deleted" / "Off". */
  const logSummary = () => {
    if (!logSettings) return '—';
    if (!logSettings.enabled) return t('admin.euAiAct.detection.accessOverview.logOff', 'Off');
    if (logSettings.retentionDays > 0) {
      return t('admin.euAiAct.detection.accessOverview.logOnDays', 'On, kept for {{days}} days', {
        days: logSettings.retentionDays
      });
    }
    return t('admin.euAiAct.detection.accessOverview.logOnKeep', 'On, kept until deleted');
  };
  const anchorCount = Array.isArray(settings?.signing?.trustedAnchors)
    ? settings.signing.trustedAnchors.length
    : (status?.signing?.trustedAnchorCount ?? 0);

  return (
    <div className="space-y-6">
      <DetectionTestPanel />

      {/* ── Access overview ──────────────────────────────────────────── */}
      <SectionCard
        id="eu-detect-access"
        title={t('admin.euAiAct.detection.accessOverview.title', 'Detector access')}
        actions={
          <SettingsLink>
            {t('admin.euAiAct.detection.accessOverview.change', 'Change in Settings')}
          </SettingsLink>
        }
      >
        {settingsState === 'error' && (
          <Notice
            tone="warning"
            title={t(
              'admin.euAiAct.detection.accessOverview.loadError',
              'The detection settings could not be loaded: {{error}}',
              { error: settingsError }
            )}
          >
            <div className="pt-1">
              <Button size="sm" icon={ArrowPathIcon} onClick={loadSettings}>
                {t('admin.euAiAct.detection.retry', 'Try again')}
              </Button>
            </div>
          </Notice>
        )}
        {detection.enabled === false && (
          <Notice
            tone="error"
            title={t(
              'admin.euAiAct.detection.accessOverview.disabled',
              'Detection is switched off. Nobody can check content from this installation, and the installation does not conform.'
            )}
          />
        )}
        <DefinitionList
          items={[
            {
              label: t('admin.euAiAct.detection.accessOverview.status', 'Detection'),
              value:
                detection.enabled === false ? (
                  <StatusPill tone="error">
                    {t('admin.euAiAct.detection.accessOverview.off', 'Off')}
                  </StatusPill>
                ) : (
                  <StatusPill tone="success">
                    {t('admin.euAiAct.detection.accessOverview.on', 'On')}
                  </StatusPill>
                )
            },
            {
              label: t('admin.euAiAct.detection.accessOverview.access', 'Who may use it'),
              value: (
                <>
                  <span className="font-medium">{access.label}</span>
                  {access.description && (
                    <span className="block text-gray-600 dark:text-gray-400">
                      {access.description}
                    </span>
                  )}
                </>
              )
            },
            {
              label: t('admin.euAiAct.detection.accessOverview.rateLimit', 'Rate limit'),
              value: rateLimit
                ? t(
                    'admin.euAiAct.detection.accessOverview.rateLimitValue',
                    '{{limit}} checks per {{minutes}} minutes',
                    { limit: rateLimit.limit, minutes: rateLimit.windowMinutes }
                  )
                : '—'
            },
            {
              label: t('admin.euAiAct.detection.accessOverview.log', 'Detection log'),
              value: logSummary()
            },
            {
              label: t('admin.euAiAct.detection.accessOverview.zeroRetention', 'Submitted content'),
              value: (
                <span className="inline-flex items-center gap-1.5">
                  <LockClosedIcon className="h-4 w-4 text-gray-500" aria-hidden="true" />
                  {t(
                    'admin.euAiAct.detection.accessOverview.zeroRetentionValue',
                    'Never stored (zero retention, fixed)'
                  )}
                </span>
              )
            }
          ]}
        />
      </SectionCard>

      <DetectionExpertsPanel experts={experts} onChanged={handleExpertsChanged} />

      <DetectionKeyGroupsPanel onChanged={reload} />

      {/* ── Trusted anchors ─────────────────────────────────────────── */}
      <SectionCard
        id="eu-detect-anchors"
        title={t('admin.euAiAct.detection.anchors.title', 'Trusted anchors')}
        actions={
          <SettingsLink>
            {t('admin.euAiAct.detection.anchors.change', 'Manage in Settings')}
          </SettingsLink>
        }
      >
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t(
            'admin.euAiAct.detection.anchors.count',
            '{{count}} additional trust anchors are configured.',
            { count: anchorCount }
          )}{' '}
          {t(
            'admin.euAiAct.detection.anchors.explanation',
            'Besides its own root, the detector trusts content signed by these installations, e.g. other installations of the same customer.'
          )}
        </p>
      </SectionCard>

      <DetectionLogPanel
        logEnabled={logSettings ? logSettings.enabled !== false : true}
        retentionDays={logSettings?.retentionDays}
      />

      <DetectionBenchmarkPanel onChanged={reload} />
    </div>
  );
}

export default DetectionTab;
