// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { createConfigRevision } from '../../../api/adminConfigRevision';
import AdminLoadGate from '../components/AdminLoadGate';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import AdminSaveBar from '../components/AdminSaveBar';

const DEFAULT_TELEMETRY = {
  enabled: false,
  provider: 'console',
  exporters: {
    otlp: {
      endpoint: 'http://localhost:4318',
      protocol: 'http/protobuf',
      headers: {}
    },
    prometheus: {
      port: 9464,
      host: '127.0.0.1'
    }
  },
  spans: {
    enabled: true,
    sampleRate: 1.0,
    includeOptInAttributes: false,
    userIdMode: 'pseudonymised'
  },
  events: {
    enabled: true,
    includePrompts: false,
    includeCompletions: false,
    maxEventSize: 1024
  },
  metrics: {
    enabled: true,
    exportInterval: 60000
  },
  logs: {
    enabled: false,
    level: 'info'
  },
  activitySummary: {
    enabled: false,
    intervalSeconds: 300,
    windowMinutes: 5
  },
  autoInstrumentation: false
};

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base?.[key] || {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function AdminTelemetryPage() {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  // A failed save keeps the bar (to retry or discard) even when the form is back at its saved
  // state: the write may have gone through and only its answer been lost.
  const [saveFailed, setSaveFailed] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState(DEFAULT_TELEMETRY);
  // The configuration as last loaded or saved; null until it loaded.
  const [savedConfig, setSavedConfig] = useState(null);
  const { blocker, isDirty } = useUnsavedChanges(savedConfig, config);
  // The revision of platform.json this form was loaded from (then: last saved).
  // Its save sends exactly this as If-Match; a 412 leaves it as it is, so the
  // next save is refused again until the page reloads or the admin chooses
  // "Keep my changes and overwrite" (which re-reads into this holder).
  const revisionRef = useRef(null);

  // No form and no Save until the platform config loaded: saving after a failed
  // load would write the defaults below over the real telemetry block (OB-B1).
  const load = useAdminConfigLoad({
    sources: {
      platform: {
        load: async () => {
          const revision = createConfigRevision();
          const response = await makeAdminApiCall('/admin/configs/platform', {
            method: 'GET',
            revision
          });
          return { platform: response.data || {}, revision: revision.current };
        },
        // Only a current (not stale) load sets the form's revision.
        onLoad: ({ platform, revision }) => {
          revisionRef.current = revision;
          const loaded = deepMerge(DEFAULT_TELEMETRY, platform.telemetry || {});
          setConfig(loaded);
          setSavedConfig(loaded);
        }
      }
    }
  });
  const ready = load.status === 'ready';

  const handleSave = async () => {
    if (!ready) return;
    const maxEventSize = config.events?.maxEventSize;
    if (
      maxEventSize !== undefined &&
      !(Number.isInteger(maxEventSize) && maxEventSize >= 1 && maxEventSize <= 4096)
    ) {
      setSaveFailed(true);
      setMessage({
        type: 'error',
        text: t(
          'admin.telemetry.maxEventSizeInvalid',
          'Max captured characters must be a whole number from 1 to 4096.'
        )
      });
      return;
    }
    try {
      setSaving(true);
      setSaveFailed(false);
      setMessage('');
      // Read-modify-write for the sections this page does not show. This read
      // does not change the revision the save sends (the one the form loaded).
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const platform = response.data || {};
      platform.telemetry = config;
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        body: platform,
        revision: revisionRef
      });
      setSavedConfig(config);
      setMessage({
        type: 'success',
        text: t(
          'admin.telemetry.saveSuccess',
          'Telemetry configuration saved. Some changes (provider, exporter, enabled) require a restart.'
        )
      });
    } catch (error) {
      setSaveFailed(true);
      setMessage({
        type: 'error',
        text:
          error.message || t('admin.telemetry.saveError', 'Failed to save telemetry configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  // Back to the configuration as loaded or last saved, with the banner of a refused save gone.
  const handleDiscard = () => {
    setConfig(savedConfig);
    setSaveFailed(false);
    setMessage('');
  };

  const updateField = (path, value) => {
    // Two-layer defense against prototype pollution:
    //   1. Reject any path that contains __proto__, constructor or prototype.
    //   2. When we have to create intermediate objects, use Object.create(null)
    //      so they have no prototype chain to pollute.
    const segments = path.split('.');
    if (segments.some(s => s === '__proto__' || s === 'constructor' || s === 'prototype')) {
      return;
    }
    setConfig(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      let cursor = next;
      for (let i = 0; i < segments.length - 1; i++) {
        const key = segments[i];
        if (
          !Object.hasOwn(cursor, key) ||
          typeof cursor[key] !== 'object' ||
          cursor[key] === null
        ) {
          cursor[key] = Object.create(null);
        }
        cursor = cursor[key];
      }
      cursor[segments[segments.length - 1]] = value;
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
          <div className="flex items-start mb-2">
            <Icon name="chart-bar" className="w-8 h-8 mr-3 text-blue-500 shrink-0" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.telemetry.title', 'Telemetry & Observability')}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.telemetry.description',
                  'Configure OpenTelemetry instrumentation following the Gen-AI semantic conventions. Spans, events and metrics can be exported to console, Prometheus or any OTLP-compatible backend (Jaeger, Tempo, Grafana, ...).'
                )}
              </p>
            </div>
          </div>
        </div>

        {message && (
          <div
            className={`p-4 rounded-lg ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
            }`}
          >
            <div className="flex items-start">
              <Icon
                name={message.type === 'success' ? 'CheckCircleIcon' : 'ExclamationCircleIcon'}
                className="w-5 h-5 mr-2 shrink-0"
              />
              <p className="text-sm">{message.text}</p>
            </div>
          </div>
        )}

        {!ready ? (
          <AdminLoadGate
            load={load}
            resourceLabel={t('admin.telemetry.resource', 'telemetry settings')}
          />
        ) : (
          <>
            {/* Master switch */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
                <Icon name="cog" className="w-5 h-5 mr-2 text-blue-500" />
                {t('admin.telemetry.general', 'General')}
              </h2>
              <label className="flex items-center mb-4">
                <input
                  type="checkbox"
                  checked={config.enabled || false}
                  onChange={e => updateField('enabled', e.target.checked)}
                  className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.telemetry.enable', 'Enable telemetry (requires restart)')}
                </span>
              </label>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('admin.telemetry.provider', 'Exporter Provider')}
                </label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[
                    {
                      id: 'console',
                      label: 'Console',
                      desc: t(
                        'admin.telemetry.providerConsole',
                        'Print spans/metrics to stdout (development only)'
                      )
                    },
                    {
                      id: 'otlp',
                      label: 'OTLP',
                      desc: t(
                        'admin.telemetry.providerOtlp',
                        'Push to an OTLP-compatible collector (Jaeger, Tempo, Grafana, OTel collector)'
                      )
                    },
                    {
                      id: 'prometheus',
                      label: 'Prometheus',
                      desc: t(
                        'admin.telemetry.providerPrometheus',
                        'Expose Prometheus metrics endpoint for scraping'
                      )
                    }
                  ].map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => updateField('provider', p.id)}
                      className={`p-3 rounded-lg border-2 text-left transition-all ${
                        config.provider === p.id
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                          : 'border-gray-200 dark:border-gray-600 hover:border-blue-300'
                      }`}
                    >
                      <div className="font-semibold text-gray-900 dark:text-gray-100">
                        {p.label}
                      </div>
                      <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{p.desc}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Provider-specific config */}
            {config.provider === 'otlp' && (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  {t('admin.telemetry.otlpSettings', 'OTLP Settings')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.telemetry.otlpEndpoint', 'Endpoint')}
                    </label>
                    <input
                      type="text"
                      value={config.exporters?.otlp?.endpoint || ''}
                      onChange={e => updateField('exporters.otlp.endpoint', e.target.value)}
                      className="w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      placeholder="http://localhost:4318"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'admin.telemetry.otlpEndpointHelp',
                        'Base URL for the OTLP/HTTP collector. /v1/traces and /v1/metrics are appended.'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {config.provider === 'prometheus' && (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  {t('admin.telemetry.prometheusSettings', 'Prometheus Settings')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.telemetry.promPort', 'Port')}
                    </label>
                    <input
                      type="number"
                      value={config.exporters?.prometheus?.port || 9464}
                      onChange={e =>
                        updateField(
                          'exporters.prometheus.port',
                          Number.parseInt(e.target.value, 10)
                        )
                      }
                      className="w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.telemetry.promHost', 'Bind Host')}
                    </label>
                    <input
                      type="text"
                      value={config.exporters?.prometheus?.host || '127.0.0.1'}
                      onChange={e => updateField('exporters.prometheus.host', e.target.value)}
                      className="w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {t(
                    'admin.telemetry.promHelp',
                    'Metrics will be available at http://{host}:{port}/metrics for Prometheus to scrape. The endpoint has no authentication: 127.0.0.1 keeps it on this host; set 0.0.0.0 only behind a firewall or a Kubernetes NetworkPolicy.'
                  )}
                </p>
              </div>
            )}

            {/* Spans / Events / Metrics */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {t('admin.telemetry.signals', 'Signals')}
              </h2>
              <div className="space-y-4">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.spans?.enabled !== false}
                    onChange={e => updateField('spans.enabled', e.target.checked)}
                    className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    {t('admin.telemetry.spans', 'Emit spans (gen_ai.* attributes)')}
                  </span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.metrics?.enabled !== false}
                    onChange={e => updateField('metrics.enabled', e.target.checked)}
                    className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    {t(
                      'admin.telemetry.metrics',
                      'Emit metrics (token usage, durations, app/conversation counters, active users/chats)'
                    )}
                  </span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.events?.enabled !== false}
                    onChange={e => updateField('events.enabled', e.target.checked)}
                    className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    {t(
                      'admin.telemetry.events',
                      'Emit gen_ai events (prompts, completions, tool calls)'
                    )}
                  </span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.autoInstrumentation === true}
                    onChange={e => updateField('autoInstrumentation', e.target.checked)}
                    className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    {t(
                      'admin.telemetry.autoInstrumentation',
                      'Auto-instrument HTTP, fetch and Express; URLs are exported without query strings (requires restart)'
                    )}
                  </span>
                </label>
              </div>

              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('admin.telemetry.privacy', 'Content & Privacy')}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">
                  {t(
                    'admin.telemetry.privacyWarn',
                    'Including prompts and completions exports conversation text to the trace backend. E-mail addresses, phone numbers, IBANs and keys are redacted on a best-effort basis; names and other personal data are not. Keep it off in production; turning it on is written to the audit log.'
                  )}
                </p>
                <div className="space-y-3">
                  <div>
                    <label
                      htmlFor="telemetry-user-id-mode"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      {t('admin.telemetry.userIdMode', 'User on spans')}
                    </label>
                    <select
                      id="telemetry-user-id-mode"
                      value={config.spans?.userIdMode || 'pseudonymised'}
                      onChange={e => updateField('spans.userIdMode', e.target.value)}
                      aria-describedby="telemetry-user-id-mode-help"
                      className="w-full md:w-1/2 px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    >
                      <option value="pseudonymised">
                        {t(
                          'admin.telemetry.userIdModePseudonymised',
                          'Pseudonymised (recommended)'
                        )}
                      </option>
                      <option value="off">
                        {t('admin.telemetry.userIdModeOff', 'Not recorded')}
                      </option>
                      <option value="clear">
                        {t('admin.telemetry.userIdModeClear', 'Clear text user id')}
                      </option>
                    </select>
                    <p
                      id="telemetry-user-id-mode-help"
                      className="text-xs text-gray-500 dark:text-gray-400 mt-1"
                    >
                      {t(
                        'admin.telemetry.userIdModeHelp',
                        'Pseudonymised spans carry a keyed hash (user.hash) instead of the login, so traces of one user can be grouped without naming them. Clear text exports the login and may need a works agreement.'
                      )}
                    </p>
                  </div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.events?.includePrompts || false}
                      onChange={e => updateField('events.includePrompts', e.target.checked)}
                      className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.telemetry.includePrompts', 'Include prompt content in events')}
                    </span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.events?.includeCompletions || false}
                      onChange={e => updateField('events.includeCompletions', e.target.checked)}
                      className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t(
                        'admin.telemetry.includeCompletions',
                        'Include completion content in events'
                      )}
                    </span>
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {t('admin.telemetry.maxEventSize', 'Max captured characters (up to 4096)')}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={4096}
                        value={config.events?.maxEventSize || 1024}
                        onChange={e =>
                          // Kept as typed (1.5 stays 1.5) so the save can refuse it.
                          updateField(
                            'events.maxEventSize',
                            e.target.value === '' ? undefined : Number(e.target.value)
                          )
                        }
                        className="w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {t('admin.telemetry.exportInterval', 'Metric export interval (ms)')}
                      </label>
                      <input
                        type="number"
                        value={config.metrics?.exportInterval || 60000}
                        onChange={e =>
                          updateField('metrics.exportInterval', Number.parseInt(e.target.value, 10))
                        }
                        className="w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Activity summary */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
                <Icon name="users" className="w-5 h-5 mr-2 text-blue-500" />
                {t('admin.telemetry.activitySummary', 'Activity Summary')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                {t(
                  'admin.telemetry.activitySummaryDescription',
                  'Periodically log the number of distinct active users and chats observed in a rolling window. Counts are also exposed as the OpenTelemetry observable gauges ihub.active.users and ihub.active.chats.'
                )}
              </p>
              <label className="flex items-center mb-3">
                <input
                  type="checkbox"
                  checked={config.activitySummary?.enabled || false}
                  onChange={e => updateField('activitySummary.enabled', e.target.checked)}
                  className="rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                  {t(
                    'admin.telemetry.activitySummaryEnable',
                    'Enable periodic activity summary log'
                  )}
                </span>
              </label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.telemetry.summaryInterval', 'Log every (seconds)')}
                  </label>
                  <input
                    type="number"
                    min={10}
                    value={config.activitySummary?.intervalSeconds || 300}
                    onChange={e =>
                      updateField(
                        'activitySummary.intervalSeconds',
                        Number.parseInt(e.target.value, 10)
                      )
                    }
                    className="w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.telemetry.summaryWindow', 'Rolling window (minutes)')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={config.activitySummary?.windowMinutes || 5}
                    onChange={e =>
                      updateField(
                        'activitySummary.windowMinutes',
                        Number.parseInt(e.target.value, 10)
                      )
                    }
                    className="w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>
            </div>

            {/* Save */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                    {t('admin.telemetry.saveChanges', 'Save Changes')}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {t(
                      'admin.telemetry.saveDescription',
                      'Privacy/event/activity-summary changes apply immediately. Toggling enabled, exporter or provider requires a server restart.'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Reference info */}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-4">
          <div className="flex items-start">
            <Icon
              name="InformationCircleIcon"
              className="w-5 h-5 mr-2 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5"
            />
            <div className="text-sm text-blue-800 dark:text-blue-300">
              <p className="font-medium mb-1">
                {t('admin.telemetry.referenceTitle', 'Reference')}:
              </p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>
                  {t(
                    'admin.telemetry.genAiConventions',
                    'OpenTelemetry Gen-AI semantic conventions:'
                  )}{' '}
                  <a
                    href="https://opentelemetry.io/docs/specs/semconv/gen-ai/"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    opentelemetry.io/docs/specs/semconv/gen-ai
                  </a>
                </li>
                <li>
                  {t(
                    'admin.telemetry.refEnvHint',
                    'Standard OTEL_* environment variables (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME, ...) are honored at startup.'
                  )}
                </li>
                <li>
                  {t(
                    'admin.telemetry.refMetricsHint',
                    'Custom iHub metrics: ihub.app.usage, ihub.prompt.usage, ihub.errors, ihub.conversations, ihub.active.users, ihub.active.chats.'
                  )}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      {/* No bar until the platform config loaded: the defaults must never be saved over it. */}
      {ready && (
        <AdminSaveBar
          dirty={isDirty || saveFailed}
          saving={saving}
          onSave={() => void handleSave()}
          onDiscard={handleDiscard}
          message={message?.type === 'error' ? message.text : undefined}
        />
      )}
      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}

export default AdminTelemetryPage;
