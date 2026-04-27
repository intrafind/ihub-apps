import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';

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
      host: '0.0.0.0'
    }
  },
  spans: {
    enabled: true,
    sampleRate: 1.0,
    includeOptInAttributes: false
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
  }
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState(DEFAULT_TELEMETRY);

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const platform = response.data || {};
      setConfig(deepMerge(DEFAULT_TELEMETRY, platform.telemetry || {}));
      setMessage('');
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message ||
          t('admin.telemetry.loadError', 'Failed to load telemetry configuration')
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage('');
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const platform = response.data || {};
      platform.telemetry = config;
      await makeAdminApiCall('/admin/configs/platform', { method: 'POST', data: platform });
      setMessage({
        type: 'success',
        text: t(
          'admin.telemetry.saveSuccess',
          'Telemetry configuration saved. Some changes (provider, exporter, enabled) require a restart.'
        )
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message ||
          t('admin.telemetry.saveError', 'Failed to save telemetry configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const updateField = (path, value) => {
    setConfig(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const segments = path.split('.');
      let cursor = next;
      for (let i = 0; i < segments.length - 1; i++) {
        if (!cursor[segments[i]] || typeof cursor[segments[i]] !== 'object') {
          cursor[segments[i]] = {};
        }
        cursor = cursor[segments[i]];
      }
      cursor[segments[segments.length - 1]] = value;
      return next;
    });
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
          <div className="max-w-6xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <p className="text-gray-600 dark:text-gray-400">
                {t('common.loading', 'Loading...')}
              </p>
            </div>
          </div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <div className="flex items-start mb-2">
              <Icon
                name="ChartBarIcon"
                className="w-8 h-8 mr-3 text-blue-500 flex-shrink-0"
              />
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
                  className="w-5 h-5 mr-2 flex-shrink-0"
                />
                <p className="text-sm">{message.text}</p>
              </div>
            </div>
          )}

          {/* Master switch */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
              <Icon name="bolt" className="w-5 h-5 mr-2 text-blue-500" />
              {t('admin.telemetry.general', 'General')}
            </h2>
            <label className="flex items-center mb-4">
              <input
                type="checkbox"
                checked={config.enabled || false}
                onChange={e => updateField('enabled', e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
                    desc: t('admin.telemetry.providerConsole', 'Print spans/metrics to stdout (development only)')
                  },
                  {
                    id: 'otlp',
                    label: 'OTLP',
                    desc: t('admin.telemetry.providerOtlp', 'Push to an OTLP-compatible collector (Jaeger, Tempo, Grafana, OTel collector)')
                  },
                  {
                    id: 'prometheus',
                    label: 'Prometheus',
                    desc: t('admin.telemetry.providerPrometheus', 'Expose Prometheus metrics endpoint for scraping')
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
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
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
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
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
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
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
                      updateField('exporters.prometheus.port', parseInt(e.target.value, 10))
                    }
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.telemetry.promHost', 'Bind Host')}
                  </label>
                  <input
                    type="text"
                    value={config.exporters?.prometheus?.host || '0.0.0.0'}
                    onChange={e => updateField('exporters.prometheus.host', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                {t(
                  'admin.telemetry.promHelp',
                  'Metrics will be available at http://{host}:{port}/metrics for Prometheus to scrape.'
                )}
              </p>
            </div>
          )}

          {/* Spans / Events / Metrics */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('admin.telemetry.signals', 'Signals')}
            </h2>
            <div className="space-y-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.spans?.enabled !== false}
                  onChange={e => updateField('spans.enabled', e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.telemetry.metrics', 'Emit metrics (token usage, durations, app/conversation counters, active users/chats)')}
                </span>
              </label>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.events?.enabled !== false}
                  onChange={e => updateField('events.enabled', e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.telemetry.events', 'Emit gen_ai events (prompts, completions, tool calls)')}
                </span>
              </label>
            </div>

            <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.telemetry.privacy', 'Content & Privacy')}
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">
                {t(
                  'admin.telemetry.privacyWarn',
                  'Including prompts and completions may capture PII or sensitive data. Disabled by default.'
                )}
              </p>
              <div className="space-y-3">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.events?.includePrompts || false}
                    onChange={e => updateField('events.includePrompts', e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    {t('admin.telemetry.includeCompletions', 'Include completion content in events')}
                  </span>
                </label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.telemetry.maxEventSize', 'Max event size (bytes)')}
                    </label>
                    <input
                      type="number"
                      value={config.events?.maxEventSize || 1024}
                      onChange={e =>
                        updateField('events.maxEventSize', parseInt(e.target.value, 10))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
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
                        updateField('metrics.exportInterval', parseInt(e.target.value, 10))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Activity summary */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
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
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                {t('admin.telemetry.activitySummaryEnable', 'Enable periodic activity summary log')}
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
                    updateField('activitySummary.intervalSeconds', parseInt(e.target.value, 10))
                  }
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
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
                    updateField('activitySummary.windowMinutes', parseInt(e.target.value, 10))
                  }
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
            </div>
          </div>

          {/* Save */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
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
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors font-medium"
              >
                {saving
                  ? t('common.saving', 'Saving...')
                  : t('admin.telemetry.save', 'Save Telemetry Settings')}
              </button>
            </div>
          </div>

          {/* Reference info */}
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-4">
            <div className="flex items-start">
              <Icon
                name="InformationCircleIcon"
                className="w-5 h-5 mr-2 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
              />
              <div className="text-sm text-blue-800 dark:text-blue-300">
                <p className="font-medium mb-1">
                  {t('admin.telemetry.referenceTitle', 'Reference')}:
                </p>
                <ul className="list-disc list-inside space-y-1 text-xs">
                  <li>
                    OpenTelemetry Gen-AI semantic conventions:{' '}
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
      </div>
    </AdminAuth>
  );
}

export default AdminTelemetryPage;
