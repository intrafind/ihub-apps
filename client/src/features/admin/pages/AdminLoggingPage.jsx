import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

// Accepts the platform.json shape (boolean | 'off' | 'mask' | 'drop') and
// produces the string form used by the <select>. Older configs that pre-date
// the string enum stored `true`/`false`, so map those to the closest mode.
function normalizeAnonymizeIp(value) {
  if (value === true || value === 'mask') return 'mask';
  if (value === 'drop') return 'drop';
  return 'off';
}

// Mirrors `logging.http` in server/defaults/config/platform.json. Everything
// off: with bodies enabled the interceptor records user prompts, uploaded
// document content and PII.
const DEFAULT_HTTP_CONFIG = {
  inbound: {
    enabled: false,
    includeHeaders: true,
    includeRequestBody: false,
    includeResponseBody: false,
    methods: [],
    pathAllowlist: [],
    pathDenylist: ['/api/health']
  },
  outbound: {
    enabled: false,
    includeHeaders: true,
    includeRequestBody: false,
    includeResponseBody: false,
    hostAllowlist: [],
    hostDenylist: []
  },
  maxBodyBytes: 8192,
  rawBodies: false,
  autoDisableAfterMinutes: 60
};

// The list-shaped settings (methods, path and host patterns) are edited as
// comma-separated text so the form stays a single input per list.
const listToText = value => (Array.isArray(value) ? value.join(', ') : '');
const textToList = text =>
  String(text)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

/** Merge a loaded `logging.http` block over the defaults, one level deep. */
function mergeHttpConfig(loaded) {
  if (!loaded || typeof loaded !== 'object') return DEFAULT_HTTP_CONFIG;
  return {
    ...DEFAULT_HTTP_CONFIG,
    ...loaded,
    inbound: { ...DEFAULT_HTTP_CONFIG.inbound, ...(loaded.inbound || {}) },
    outbound: { ...DEFAULT_HTTP_CONFIG.outbound, ...(loaded.outbound || {}) }
  };
}

function AdminLoggingPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [loggingConfig, setLoggingConfig] = useState({
    level: 'info',
    format: 'json',
    file: {
      enabled: false,
      path: 'logs/app.log',
      maxSize: 10485760,
      maxFiles: 5
    },
    components: {
      enabled: false,
      filter: []
    },
    metadata: {
      includeTimestamp: true,
      includeComponent: true,
      includeLevel: true
    }
  });
  const [authDebugConfig, setAuthDebugConfig] = useState({
    enabled: false,
    maskTokens: true,
    redactPasswords: true,
    includeRawData: false,
    providers: {
      oidc: { enabled: true },
      local: { enabled: true },
      proxy: { enabled: true },
      ldap: { enabled: true },
      ntlm: { enabled: true }
    }
  });
  const [httpConfig, setHttpConfig] = useState(DEFAULT_HTTP_CONFIG);
  // Both anonymizeIp settings accept boolean | 'off' | 'mask' | 'drop' on the
  // server. The UI normalises everything to the string form so the <select>
  // always has a single source of truth.
  const [privacyConfig, setPrivacyConfig] = useState({
    loggingAnonymizeIp: 'off',
    auditAnonymizeIp: 'off'
  });

  const availableLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

  // Component filtering options with descriptions
  const availableComponents = [
    {
      id: 'Server',
      name: 'Server',
      description: 'Main server initialization, startup, shutdown, and clustering operations'
    },
    {
      id: 'ChatService',
      name: 'Chat Service',
      description:
        'Chat request processing, LLM interactions, streaming responses, and conversation handling'
    },
    {
      id: 'AuthService',
      name: 'Authentication Service',
      description:
        'User authentication, login/logout operations, session management (Local, OIDC, Proxy, LDAP, NTLM)'
    },
    {
      id: 'JwtAuth',
      name: 'JWT Authentication',
      description:
        'JWT token validation, user authentication via bearer tokens, token expiration checks'
    },
    {
      id: 'ConfigCache',
      name: 'Configuration Cache',
      description:
        'Configuration loading, caching, hot-reload operations for apps, models, and platform settings'
    },
    {
      id: 'ApiKeyVerifier',
      name: 'API Key Verifier',
      description:
        'Verification of provider API keys (OpenAI, Anthropic, Google, Mistral) at startup'
    },
    {
      id: 'ToolExecutor',
      name: 'Tool Executor',
      description:
        'Execution of tools called by LLMs (web search, code execution, file operations, browser automation)'
    },
    {
      id: 'DataRoutes',
      name: 'Data Routes',
      description: 'API routes for chat, prompts, models, apps, and general data endpoints'
    },
    {
      id: 'AdminRoutes',
      name: 'Admin Routes',
      description:
        'Admin API endpoints for configuration management, user management, and system administration'
    },
    {
      id: 'ModelsRoutes',
      name: 'Models Admin Routes',
      description: 'Admin API endpoints for model configuration, updates, and management'
    },
    {
      id: 'Middleware',
      name: 'Middleware',
      description:
        'Request processing middleware (CORS, authentication, rate limiting, error handling)'
    },
    {
      id: 'StaticRoutes',
      name: 'Static Routes',
      description: 'Static file serving, SPA routing, uploaded assets, and documentation serving'
    },
    {
      id: 'Swagger',
      name: 'Swagger/OpenAPI',
      description: 'API documentation generation and Swagger UI serving'
    },
    {
      id: 'Version',
      name: 'Version Info',
      description: 'Application version information, build details, and version checking'
    },
    {
      id: 'SSE',
      name: 'Server-Sent Events',
      description: 'SSE connection management for real-time LLM streaming responses'
    },
    {
      id: 'OpenAIAdapter',
      name: 'OpenAI Adapter',
      description: 'OpenAI API integration, request formatting, response parsing for GPT models'
    },
    {
      id: 'AnthropicAdapter',
      name: 'Anthropic Adapter',
      description: 'Anthropic API integration for Claude models, streaming support'
    },
    {
      id: 'GoogleAdapter',
      name: 'Google Adapter',
      description: 'Google AI (Gemini) API integration, multimodal support, safety settings'
    },
    {
      id: 'MistralAdapter',
      name: 'Mistral Adapter',
      description: 'Mistral AI API integration for Mistral models'
    },
    {
      id: 'VLLMAdapter',
      name: 'vLLM Adapter',
      description: 'vLLM server integration for local model hosting'
    },
    {
      id: 'Setup',
      name: 'Setup',
      description: 'Initial application setup, environment configuration, dependency checks'
    },
    {
      id: 'Utils',
      name: 'Utilities',
      description: 'General utility functions, helpers, and common operations'
    },
    {
      id: 'TokenStorage',
      name: 'Token Storage',
      description: 'Token storage and retrieval for authentication sessions'
    },
    {
      id: 'ResourceLoader',
      name: 'Resource Loader',
      description: 'Loading of application resources, assets, and configuration files'
    },
    {
      id: 'ModelsLoader',
      name: 'Models Loader',
      description: 'Loading and validation of model configurations'
    },
    {
      id: 'ConfigLoader',
      name: 'Config Loader',
      description: 'Configuration file loading, parsing, and validation'
    },
    {
      id: 'HttpInterceptor',
      name: 'HTTP Interceptor',
      description:
        'Raw inbound and outbound HTTP requests and responses captured by the HTTP interceptor'
    }
  ];

  useEffect(() => {
    loadConfiguration();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const loadConfiguration = async () => {
    try {
      setLoading(true);
      // Load logging config
      const loggingResponse = await makeAdminApiCall('/admin/logging/config', {
        method: 'GET'
      });

      // Set config with proper defaults for fields that might not be in response
      const loadedConfig = loggingResponse.data;
      setLoggingConfig({
        level: loadedConfig.level || 'info',
        format: loadedConfig.format || 'json',
        anonymizeIp: loadedConfig.anonymizeIp ?? false,
        file: loadedConfig.file || {
          enabled: false,
          path: 'logs/app.log',
          maxSize: 10485760,
          maxFiles: 5
        },
        components: loadedConfig.components || {
          enabled: false,
          filter: []
        },
        metadata: loadedConfig.metadata || {
          includeTimestamp: true,
          includeComponent: true,
          includeLevel: true
        }
      });

      setHttpConfig(mergeHttpConfig(loadedConfig.http));

      // Load platform config for auth debug settings. The canonical location is
      // `auth.debug` (what the server reads); merge over defaults so any fields
      // an older config omits keep sensible values.
      const platformResponse = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });
      if (platformResponse.data?.auth?.debug) {
        setAuthDebugConfig(prev => ({ ...prev, ...platformResponse.data.auth.debug }));
      }

      // Load audit-log settings (anonymizeIp lives under `audit.*`, the
      // logging variant under `logging.*`). The server normalises both to a
      // string mode so the <select> stays simple.
      const auditResponse = await makeAdminApiCall('/admin/audit-log/settings', {
        method: 'GET'
      });
      setPrivacyConfig({
        loggingAnonymizeIp: normalizeAnonymizeIp(loadedConfig.anonymizeIp),
        auditAnonymizeIp: normalizeAnonymizeIp(auditResponse.data?.anonymizeIp)
      });

      setMessage('');
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.logging.loadError', 'Failed to load logging configuration')
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveLoggingConfig = async () => {
    try {
      setSaving(true);
      setMessage('');

      await makeAdminApiCall('/admin/logging/config', {
        method: 'PUT',
        body: loggingConfig
      });

      setMessage({
        type: 'success',
        text: t('admin.logging.saveSuccess', 'Logging configuration saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.logging.saveError', 'Failed to save logging configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAuthDebugConfig = async () => {
    try {
      setSaving(true);
      setMessage('');

      // Load current platform config
      const platformResponse = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });
      const platformConfig = platformResponse.data;

      // Persist under the canonical `auth.debug` key that the server reads.
      // The platform save route merges the whole `auth` object, so keep the
      // rest of the auth config intact.
      platformConfig.auth = { ...platformConfig.auth, debug: authDebugConfig };

      // Save back
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        body: platformConfig
      });

      setMessage({
        type: 'success',
        text: t(
          'admin.logging.authDebugSaveSuccess',
          'Authentication debug configuration saved successfully'
        )
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message ||
          t('admin.logging.authDebugSaveError', 'Failed to save authentication debug configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSavePrivacyConfig = async () => {
    try {
      setSaving(true);
      setMessage('');

      // logging.anonymizeIp rides the existing logging-config PUT (shallow
      // merge of the body into platform.json's logging block). audit.* goes
      // through its dedicated settings endpoint to avoid coupling the two
      // blocks server-side.
      await makeAdminApiCall('/admin/logging/config', {
        method: 'PUT',
        body: { ...loggingConfig, anonymizeIp: privacyConfig.loggingAnonymizeIp }
      });
      await makeAdminApiCall('/admin/audit-log/settings', {
        method: 'PUT',
        body: { anonymizeIp: privacyConfig.auditAnonymizeIp }
      });

      // Reflect the saved values in `loggingConfig` so a subsequent
      // "Save Logging Configuration" click doesn't drop them again.
      setLoggingConfig(prev => ({ ...prev, anonymizeIp: privacyConfig.loggingAnonymizeIp }));

      setMessage({
        type: 'success',
        text: t('admin.logging.privacySaveSuccess', 'Privacy settings saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message || t('admin.logging.privacySaveError', 'Failed to save privacy settings')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveHttpConfig = async () => {
    try {
      setSaving(true);
      setMessage('');

      // The logging PUT shallow-merges its body into platform.json's logging
      // block, so sending only `http` leaves the other sections alone.
      await makeAdminApiCall('/admin/logging/config', {
        method: 'PUT',
        body: { http: httpConfig }
      });

      setMessage({
        type: 'success',
        text: t('admin.logging.httpSaveSuccess', 'HTTP interceptor settings saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message ||
          t('admin.logging.httpSaveError', 'Failed to save HTTP interceptor settings')
      });
    } finally {
      setSaving(false);
    }
  };

  // Convenience setter for the two direction cards, which are structurally
  // identical apart from how they select traffic.
  const setDirection = (direction, patch) =>
    setHttpConfig(prev => ({ ...prev, [direction]: { ...prev[direction], ...patch } }));

  const httpCaptureOn = httpConfig.inbound?.enabled || httpConfig.outbound?.enabled;
  // Records are emitted at the `debug` level. Enabling capture while the level
  // is higher produces nothing at all, which is a confusing way to find out.
  const httpLevelTooHigh = httpCaptureOn && !['debug', 'silly'].includes(loggingConfig.level);
  const httpBodiesOn = Boolean(
    httpConfig.inbound?.includeRequestBody ||
    httpConfig.inbound?.includeResponseBody ||
    httpConfig.outbound?.includeRequestBody ||
    httpConfig.outbound?.includeResponseBody
  );

  const handleLevelChange = newLevel => {
    setLoggingConfig(prev => ({ ...prev, level: newLevel }));
  };

  const handleFormatChange = newFormat => {
    setLoggingConfig(prev => ({ ...prev, format: newFormat }));
  };

  const handleComponentToggle = component => {
    setLoggingConfig(prev => {
      const currentFilter = prev.components?.filter || [];
      const newFilter = currentFilter.includes(component)
        ? currentFilter.filter(c => c !== component)
        : [...currentFilter, component];
      return {
        ...prev,
        components: {
          ...prev.components,
          filter: newFilter
        }
      };
    });
  };

  const handleSelectAllComponents = () => {
    setLoggingConfig(prev => ({
      ...prev,
      components: {
        ...prev.components,
        filter: availableComponents.map(c => c.id)
      }
    }));
  };

  const handleDeselectAllComponents = () => {
    setLoggingConfig(prev => ({
      ...prev,
      components: {
        ...prev.components,
        filter: []
      }
    }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-6xl mx-auto">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <p className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <div className="flex items-start mb-2">
            <Icon
              name="AdjustmentsHorizontalIcon"
              className="w-8 h-8 mr-3 text-blue-500 flex-shrink-0"
            />
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.logging.title', 'Logging Configuration')}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.logging.description',
                  'Configure logging levels, components, metadata, and debug settings'
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Status Message */}
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

        {/* Log Level Configuration */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
            <Icon name="AdjustmentsVerticalIcon" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.logging.levelSection', 'Log Level')}
          </h2>

          {/* Current Level Display */}
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.logging.currentLevel', 'Current Level')}:
            </p>
            <p className="text-lg font-bold text-blue-600 dark:text-blue-400">
              {loggingConfig.level}
            </p>
          </div>

          {/* Level Selector */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {availableLevels.map(level => (
              <button
                key={level}
                onClick={() => handleLevelChange(level)}
                disabled={loggingConfig.level === level}
                className={`
                    p-3 rounded-lg border-2 text-left transition-all
                    ${
                      loggingConfig.level === level
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-500'
                    }
                    disabled:cursor-not-allowed cursor-pointer
                  `}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-gray-900 dark:text-gray-100 capitalize">
                    {level}
                  </span>
                  {loggingConfig.level === level && (
                    <Icon name="CheckCircleIcon" className="w-5 h-5 text-blue-500" />
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Log Format Configuration */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
            <Icon name="DocumentTextIcon" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.logging.formatSection', 'Log Format')}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {['json', 'text'].map(format => (
              <button
                key={format}
                onClick={() => handleFormatChange(format)}
                disabled={loggingConfig.format === format}
                className={`
                    p-4 rounded-lg border-2 text-left transition-all
                    ${
                      loggingConfig.format === format
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-500'
                    }
                    disabled:cursor-not-allowed cursor-pointer
                  `}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-gray-900 dark:text-gray-100 capitalize">
                    {format}
                  </span>
                  {loggingConfig.format === format && (
                    <Icon name="CheckCircleIcon" className="w-5 h-5 text-blue-500" />
                  )}
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {format === 'json'
                    ? t('admin.logging.jsonDescription', 'Structured JSON logging')
                    : t('admin.logging.textDescription', 'Human-readable text format')}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Component Filtering */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
            <Icon name="FunnelIcon" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.logging.componentSection', 'Component Filtering')}
          </h2>

          <div className="mb-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={loggingConfig.components?.enabled || false}
                onChange={e =>
                  setLoggingConfig(prev => ({
                    ...prev,
                    components: { ...prev.components, enabled: e.target.checked }
                  }))
                }
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                {t('admin.logging.enableComponentFilter', 'Enable component filtering')}
              </span>
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
              {t(
                'admin.logging.componentFilterHelp',
                'When enabled, only logs from selected components will be shown'
              )}
            </p>
          </div>

          {loggingConfig.components?.enabled && (
            <div className="mb-4 flex gap-2">
              <button
                onClick={handleSelectAllComponents}
                className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
              >
                {t('admin.logging.selectAll', 'Select All')}
              </button>
              <button
                onClick={handleDeselectAllComponents}
                className="px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-white rounded-md transition-colors"
              >
                {t('admin.logging.deselectAll', 'Deselect All')}
              </button>
            </div>
          )}

          {loggingConfig.components?.enabled && (
            <div className="space-y-3">
              {availableComponents.map(component => (
                <label
                  key={component.id}
                  className="flex items-start p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={loggingConfig.components?.filter?.includes(component.id) || false}
                    onChange={() => handleComponentToggle(component.id)}
                    className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <div className="ml-3 flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {component.name}
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                      {component.description}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* PII & Privacy */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2 flex items-center">
            <Icon name="ShieldCheckIcon" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.logging.privacySection', 'PII & Privacy')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t(
              'admin.logging.privacyDescription',
              "Anonymize client IP addresses before they're persisted to logs or the audit log."
            )}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="logging-anonymize-ip"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t('admin.logging.loggingAnonymizeIp', 'Anonymize IP in structured logs')}
              </label>
              <select
                id="logging-anonymize-ip"
                value={privacyConfig.loggingAnonymizeIp}
                onChange={e =>
                  setPrivacyConfig(prev => ({ ...prev, loggingAnonymizeIp: e.target.value }))
                }
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                <option value="off">
                  {t('admin.logging.anonymizeIpOff', 'Off — store IP verbatim')}
                </option>
                <option value="mask">
                  {t('admin.logging.anonymizeIpMask', 'Mask — /24 (IPv4) or /48 (IPv6)')}
                </option>
                <option value="drop">
                  {t('admin.logging.anonymizeIpDrop', 'Drop — omit the field entirely')}
                </option>
              </select>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t(
                  'admin.logging.loggingAnonymizeIpHelp',
                  'Applies to the IP merged into every log line from the per-request context.'
                )}
              </p>
            </div>

            <div>
              <label
                htmlFor="audit-anonymize-ip"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t('admin.logging.auditAnonymizeIp', 'Anonymize IP in audit log')}
              </label>
              <select
                id="audit-anonymize-ip"
                value={privacyConfig.auditAnonymizeIp}
                onChange={e =>
                  setPrivacyConfig(prev => ({ ...prev, auditAnonymizeIp: e.target.value }))
                }
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                <option value="off">
                  {t('admin.logging.anonymizeIpOff', 'Off — store IP verbatim')}
                </option>
                <option value="mask">
                  {t('admin.logging.anonymizeIpMask', 'Mask — /24 (IPv4) or /48 (IPv6)')}
                </option>
                <option value="drop">
                  {t('admin.logging.anonymizeIpDrop', 'Drop — omit the field entirely')}
                </option>
              </select>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t(
                  'admin.logging.auditAnonymizeIpHelp',
                  'Applies to the `ip` field on each audit entry.'
                )}
              </p>
            </div>
          </div>

          <div className="mt-4">
            <button
              onClick={handleSavePrivacyConfig}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
            >
              {saving
                ? t('common.saving', 'Saving...')
                : t('admin.logging.savePrivacy', 'Save Privacy Settings')}
            </button>
          </div>
        </div>

        {/* File Logging */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
            <Icon name="DocumentIcon" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.logging.fileSection', 'File Logging')}
          </h2>

          <div className="space-y-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={loggingConfig.file?.enabled || false}
                onChange={e =>
                  setLoggingConfig(prev => ({
                    ...prev,
                    file: { ...prev.file, enabled: e.target.checked }
                  }))
                }
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                {t('admin.logging.enableFileLogging', 'Enable file logging')}
              </span>
            </label>

            {loggingConfig.file?.enabled && (
              <div className="ml-6 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.logging.filePath', 'Log File Path')}
                  </label>
                  <input
                    type="text"
                    value={loggingConfig.file?.path || ''}
                    onChange={e =>
                      setLoggingConfig(prev => ({
                        ...prev,
                        file: { ...prev.file, path: e.target.value }
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.logging.maxSize', 'Max Size (bytes)')}
                    </label>
                    <input
                      type="number"
                      value={loggingConfig.file?.maxSize || 10485760}
                      onChange={e =>
                        setLoggingConfig(prev => ({
                          ...prev,
                          file: { ...prev.file, maxSize: parseInt(e.target.value) }
                        }))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.logging.maxFiles', 'Max Files')}
                    </label>
                    <input
                      type="number"
                      value={loggingConfig.file?.maxFiles || 5}
                      onChange={e =>
                        setLoggingConfig(prev => ({
                          ...prev,
                          file: { ...prev.file, maxFiles: parseInt(e.target.value) }
                        }))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* HTTP Interceptor */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2 flex items-center">
            <Icon name="ArrowsRightLeftIcon" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.logging.httpSection', 'HTTP Interceptor')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t(
              'admin.logging.httpDescription',
              'Records the raw HTTP traffic on both sides: every request this server serves, and every request it makes to LLM providers, integrations and MCP servers. Each record carries the request ID, so an outbound provider call can be traced back to the chat request that caused it. Records are written at the "debug" level under the component "HttpInterceptor".'
            )}
          </p>

          <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4">
            <div className="flex items-start">
              <Icon
                name="ExclamationTriangleIcon"
                className="w-5 h-5 mr-2 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5"
              />
              <div className="text-sm text-amber-800 dark:text-amber-300">
                {t(
                  'admin.logging.httpWarning',
                  'Turn this on to chase a specific problem, then turn it off. With bodies enabled it captures user prompts, uploaded document content and personal data. Credentials are masked unless raw mode is on.'
                )}
              </div>
            </div>
          </div>

          {httpLevelTooHigh && (
            <div className="mb-4 rounded-lg border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 p-4">
              <div className="flex items-start">
                <Icon
                  name="InformationCircleIcon"
                  className="w-5 h-5 mr-2 text-yellow-700 dark:text-yellow-400 flex-shrink-0 mt-0.5"
                />
                <div className="text-sm text-yellow-800 dark:text-yellow-300">
                  {t(
                    'admin.logging.httpLevelWarning',
                    'Capture is on, but the log level is above "debug" — no records will be written. Set the log level to "debug" for these records to appear.'
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Inbound */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={httpConfig.inbound?.enabled || false}
                  onChange={e => setDirection('inbound', { enabled: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.logging.httpInbound', 'Capture inbound requests')}
                </span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                {t(
                  'admin.logging.httpInboundHelp',
                  'Requests served by this server. Static assets are always skipped.'
                )}
              </p>

              {httpConfig.inbound?.enabled && (
                <div className="mt-3 ml-6 space-y-3 border-l-2 border-blue-200 dark:border-blue-800 pl-4">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={httpConfig.inbound?.includeHeaders !== false}
                      onChange={e => setDirection('inbound', { includeHeaders: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.httpIncludeHeaders', 'Include headers')}
                    </span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={httpConfig.inbound?.includeRequestBody || false}
                      onChange={e =>
                        setDirection('inbound', { includeRequestBody: e.target.checked })
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.httpIncludeRequestBody', 'Include request bodies')}
                    </span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={httpConfig.inbound?.includeResponseBody || false}
                      onChange={e =>
                        setDirection('inbound', { includeResponseBody: e.target.checked })
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.httpIncludeResponseBody', 'Include response bodies')}
                    </span>
                  </label>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.logging.httpMethods', 'Methods')}
                    </label>
                    <input
                      type="text"
                      value={listToText(httpConfig.inbound?.methods)}
                      onChange={e =>
                        setDirection('inbound', { methods: textToList(e.target.value) })
                      }
                      placeholder={t('admin.logging.httpAllPlaceholder', 'Empty = all')}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.logging.httpPathAllowlist', 'Path allowlist')}
                    </label>
                    <input
                      type="text"
                      value={listToText(httpConfig.inbound?.pathAllowlist)}
                      onChange={e =>
                        setDirection('inbound', { pathAllowlist: textToList(e.target.value) })
                      }
                      placeholder="/api/chat, /api/admin"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'admin.logging.httpPathAllowlistHelp',
                        'Empty captures every path except the denylist. Entries match a path exactly or as a path prefix.'
                      )}
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.logging.httpPathDenylist', 'Path denylist')}
                    </label>
                    <input
                      type="text"
                      value={listToText(httpConfig.inbound?.pathDenylist)}
                      onChange={e =>
                        setDirection('inbound', { pathDenylist: textToList(e.target.value) })
                      }
                      placeholder="/api/health"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Outbound */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={httpConfig.outbound?.enabled || false}
                  onChange={e => setDirection('outbound', { enabled: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.logging.httpOutbound', 'Capture outbound requests')}
                </span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                {t(
                  'admin.logging.httpOutboundHelp',
                  'Requests this server makes: LLM providers, integrations, MCP servers, web search.'
                )}
              </p>

              {httpConfig.outbound?.enabled && (
                <div className="mt-3 ml-6 space-y-3 border-l-2 border-blue-200 dark:border-blue-800 pl-4">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={httpConfig.outbound?.includeHeaders !== false}
                      onChange={e => setDirection('outbound', { includeHeaders: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.httpIncludeHeaders', 'Include headers')}
                    </span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={httpConfig.outbound?.includeRequestBody || false}
                      onChange={e =>
                        setDirection('outbound', { includeRequestBody: e.target.checked })
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.httpIncludeRequestBody', 'Include request bodies')}
                    </span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={httpConfig.outbound?.includeResponseBody || false}
                      onChange={e =>
                        setDirection('outbound', { includeResponseBody: e.target.checked })
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.httpIncludeResponseBody', 'Include response bodies')}
                    </span>
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.logging.httpStreamNote',
                      'Streamed responses (chat, agents, workflows) are recorded with status, headers and timing, but their bodies are never buffered.'
                    )}
                  </p>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.logging.httpHostAllowlist', 'Host allowlist')}
                    </label>
                    <input
                      type="text"
                      value={listToText(httpConfig.outbound?.hostAllowlist)}
                      onChange={e =>
                        setDirection('outbound', { hostAllowlist: textToList(e.target.value) })
                      }
                      placeholder="api.openai.com, *.anthropic.com"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'admin.logging.httpHostAllowlistHelp',
                        'Empty captures every host except the denylist. "*.example.com" matches subdomains only.'
                      )}
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.logging.httpHostDenylist', 'Host denylist')}
                    </label>
                    <input
                      type="text"
                      value={listToText(httpConfig.outbound?.hostDenylist)}
                      onChange={e =>
                        setDirection('outbound', { hostDenylist: textToList(e.target.value) })
                      }
                      placeholder="telemetry.example.com"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Shared limits */}
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('admin.logging.httpMaxBodyBytes', 'Max body size (bytes)')}
              </label>
              <input
                type="number"
                min="0"
                value={httpConfig.maxBodyBytes ?? 8192}
                onChange={e =>
                  setHttpConfig(prev => ({
                    ...prev,
                    maxBodyBytes: Math.max(0, parseInt(e.target.value, 10) || 0)
                  }))
                }
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t(
                  'admin.logging.httpMaxBodyBytesHelp',
                  'Captured bodies are truncated at this size and the record says how much was dropped. 0 means no limit, which can hold a whole upload in memory.'
                )}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('admin.logging.httpAutoDisable', 'Auto-disable after (minutes)')}
              </label>
              <input
                type="number"
                min="0"
                value={httpConfig.autoDisableAfterMinutes ?? 60}
                onChange={e =>
                  setHttpConfig(prev => ({
                    ...prev,
                    autoDisableAfterMinutes: Math.max(0, parseInt(e.target.value, 10) || 0)
                  }))
                }
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t(
                  'admin.logging.httpAutoDisableHelp',
                  'Capture stops on its own this long after it was switched on, so an interceptor left running in production turns itself off. Saving again restarts the window. 0 means never.'
                )}
              </p>
            </div>
          </div>

          {httpBodiesOn && (
            <div className="mt-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={httpConfig.rawBodies || false}
                  onChange={e => setHttpConfig(prev => ({ ...prev, rawBodies: e.target.checked }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.logging.httpRawBodies', 'Raw mode (no redaction, no size limit)')}
                </span>
              </label>
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 ml-6">
                {t(
                  'admin.logging.httpRawBodiesWarning',
                  'Security risk: writes API keys, tokens, cookies and full request bodies to the log in clear text. For the case where redaction is hiding the value you are chasing — turn it off again straight afterwards.'
                )}
              </p>
            </div>
          )}

          <div className="mt-4">
            <button
              onClick={handleSaveHttpConfig}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
            >
              {saving
                ? t('common.saving', 'Saving...')
                : t('admin.logging.saveHttp', 'Save HTTP Interceptor Settings')}
            </button>
          </div>
        </div>

        {/* Authentication Debug Logging */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2 flex items-center">
            <Icon name="ShieldCheckIcon" className="w-5 h-5 mr-2 text-blue-500" />
            {t('admin.logging.authDebugSection', 'Authentication Debug Logging')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t(
              'admin.logging.authDebugDescription',
              'The single place to trace authentication flows — OIDC redirects, token exchange, group mapping, NTLM handshakes. Traces are written at the "info" level, so they appear at the default log level without any further changes and take effect immediately (no restart needed).'
            )}
          </p>

          <div className="space-y-4">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={authDebugConfig.enabled || false}
                onChange={e => setAuthDebugConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.logging.enableAuthDebug', 'Enable authentication debug logging')}
              </span>
            </label>

            {authDebugConfig.enabled && (
              <div className="ml-6 space-y-3 border-l-2 border-blue-200 dark:border-blue-800 pl-4">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={authDebugConfig.maskTokens !== false}
                    onChange={e =>
                      setAuthDebugConfig(prev => ({ ...prev, maskTokens: e.target.checked }))
                    }
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    {t('admin.logging.maskTokens', 'Mask tokens in logs')}
                  </span>
                </label>

                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={authDebugConfig.redactPasswords !== false}
                    onChange={e =>
                      setAuthDebugConfig(prev => ({
                        ...prev,
                        redactPasswords: e.target.checked
                      }))
                    }
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    {t('admin.logging.redactPasswords', 'Redact passwords in logs')}
                  </span>
                </label>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={authDebugConfig.includeRawData || false}
                      onChange={e =>
                        setAuthDebugConfig(prev => ({
                          ...prev,
                          includeRawData: e.target.checked
                        }))
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.includeRawData', 'Include raw authentication data')}
                    </span>
                  </label>
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 ml-6">
                    {t(
                      'admin.logging.includeRawDataWarning',
                      'Security risk: logs the full user-info payload and access tokens. Leave off unless actively debugging; disable again afterwards.'
                    )}
                  </p>
                </div>

                {/* Provider-specific debug settings */}
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.logging.authProviders', 'Debug by Provider')}
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {Object.keys(authDebugConfig.providers || {}).map(provider => (
                      <label key={provider} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={authDebugConfig.providers?.[provider]?.enabled !== false}
                          onChange={e =>
                            setAuthDebugConfig(prev => ({
                              ...prev,
                              providers: {
                                ...prev.providers,
                                [provider]: { enabled: e.target.checked }
                              }
                            }))
                          }
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300 capitalize">
                          {provider}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4">
            <button
              onClick={handleSaveAuthDebugConfig}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
            >
              {saving
                ? t('common.saving', 'Saving...')
                : t('admin.logging.saveAuthDebug', 'Save Authentication Debug Settings')}
            </button>
          </div>
        </div>

        {/* Save Button */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {t('admin.logging.saveChanges', 'Save Changes')}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.logging.saveDescription',
                  'Save logging configuration and apply changes immediately'
                )}
              </p>
            </div>
            <button
              onClick={handleSaveLoggingConfig}
              disabled={saving}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors font-medium"
            >
              {saving
                ? t('common.saving', 'Saving...')
                : t('admin.logging.save', 'Save Logging Configuration')}
            </button>
          </div>
        </div>

        {/* Info Box */}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-4">
          <div className="flex items-start">
            <Icon
              name="InformationCircleIcon"
              className="w-5 h-5 mr-2 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
            />
            <div className="text-sm text-blue-800 dark:text-blue-300">
              <p className="font-medium mb-1">{t('common.note', 'Note')}:</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>
                  {t(
                    'admin.logging.note1',
                    'Changes take effect immediately across all server processes'
                  )}
                </li>
                <li>
                  {t(
                    'admin.logging.note2',
                    'Log level changes are persisted to platform.json configuration'
                  )}
                </li>
                <li>
                  {t(
                    'admin.logging.note3',
                    'Lower levels (error, warn) show fewer messages, higher levels (debug, silly) show more'
                  )}
                </li>
                <li>
                  {t(
                    'admin.logging.note4',
                    'Use "info" level for production, "debug" for development'
                  )}
                </li>
                <li>
                  {t(
                    'admin.logging.note5',
                    'Authentication debug logging applies immediately (no restart) and its traces are emitted at the "info" level, so they show at the default log level'
                  )}
                </li>
                <li>
                  {t(
                    'admin.logging.note6',
                    'The HTTP interceptor writes its records at the "debug" level under the component "HttpInterceptor" — set the log level to "debug" to see them'
                  )}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminLoggingPage;
