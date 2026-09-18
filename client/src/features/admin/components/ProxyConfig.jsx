import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

const EMPTY_CONFIG = {
  enabled: true,
  http: '',
  https: '',
  noProxy: [],
  urlPatterns: []
};

/**
 * Is this string a valid JavaScript regular expression? The server rejects
 * uncompilable `urlPatterns` on save; checking here means the admin finds out
 * while typing instead of after pressing Save.
 */
function isValidRegex(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function ProxyConfig() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [provenance, setProvenance] = useState({});
  const [effective, setEffective] = useState(null);
  const [unresolvedPlaceholders, setUnresolvedPlaceholders] = useState({});
  const [newNoProxy, setNewNoProxy] = useState('');
  const [newPattern, setNewPattern] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const [testUrl, setTestUrl] = useState('https://api.openai.com/v1/models');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState('');

  const applyResponse = useCallback(data => {
    setConfig({
      enabled: data.config?.enabled !== false,
      http: data.config?.http || '',
      https: data.config?.https || '',
      noProxy: Array.isArray(data.config?.noProxy) ? data.config.noProxy : [],
      urlPatterns: Array.isArray(data.config?.urlPatterns) ? data.config.urlPatterns : []
    });
    setProvenance(data.provenance || {});
    setEffective(data.effective || null);
    setUnresolvedPlaceholders(data.unresolvedPlaceholders || {});
  }, []);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await makeAdminApiCall('/admin/proxy/config', { method: 'GET' });
        applyResponse(response.data);
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text:
            error.message ||
            t('admin.system.proxy.configLoadError', 'Failed to load proxy configuration')
        });
      } finally {
        setLoading(false);
      }
    };
    fetchConfig();
  }, [applyResponse, t]);

  const invalidPatterns = useMemo(
    () => config.urlPatterns.filter(pattern => !isValidRegex(pattern)),
    [config.urlPatterns]
  );

  /**
   * What is actually happening to outbound traffic right now.
   *
   * Read from `effective`, never from the checkbox: the switch on its own
   * proxies nothing. It defaults to on so that HTTP_PROXY from the environment
   * keeps working, which means a checked box with no URL anywhere reads as
   * "the proxy is on" while every request still goes direct. Saying which of
   * the three states the installation is in removes that guess.
   */
  const status = useMemo(() => {
    if (!effective) return null;
    if (!effective.enabled) return 'off';
    if (!effective.http && !effective.https) return 'inactive';
    return 'active';
  }, [effective]);

  const sourceLabel = field => {
    switch (provenance[field]) {
      case 'platform':
        return t('admin.system.proxy.source.platform', 'From platform.json');
      case 'environment':
        return t('admin.system.proxy.source.environment', 'From the environment');
      default:
        return t('admin.system.proxy.source.default', 'Not configured');
    }
  };

  const addNoProxyEntry = () => {
    const trimmed = newNoProxy.trim();
    if (!trimmed) return;
    setConfig(prev =>
      prev.noProxy.includes(trimmed) ? prev : { ...prev, noProxy: [...prev.noProxy, trimmed] }
    );
    setNewNoProxy('');
  };

  const addPattern = () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    setConfig(prev =>
      prev.urlPatterns.includes(trimmed)
        ? prev
        : { ...prev, urlPatterns: [...prev.urlPatterns, trimmed] }
    );
    setNewPattern('');
  };

  const handleSave = async () => {
    if (invalidPatterns.length > 0) {
      setMessage({
        type: 'error',
        text: t(
          'admin.system.proxy.invalidPatternsError',
          'Fix the invalid URL patterns before saving: {{patterns}}',
          { patterns: invalidPatterns.join(', ') }
        )
      });
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const response = await makeAdminApiCall('/admin/proxy/config', {
        method: 'PUT',
        body: config
      });
      applyResponse(response.data);
      setMessage({
        type: 'success',
        text: t('admin.system.proxy.configSaved', 'Proxy configuration saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message ||
          t('admin.system.proxy.configSaveError', 'Failed to save proxy configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError('');
    try {
      const response = await makeAdminApiCall('/admin/proxy/test', {
        method: 'POST',
        // The unsaved editor state is tested, so an admin can find a working
        // proxy before committing it.
        body: { url: testUrl, config }
      });
      setTestResult(response.data);
    } catch (error) {
      setTestError(
        error.message || t('admin.system.proxy.testFailed', 'Could not run the connectivity test')
      );
    } finally {
      setTesting(false);
    }
  };

  const decisionLabel = decision => {
    switch (decision) {
      case 'proxied':
        return t('admin.system.proxy.decision.proxied', 'Routed through the proxy');
      case 'bypassed':
        return t('admin.system.proxy.decision.bypassed', 'Bypassed — host is in the no-proxy list');
      case 'excluded':
        return t(
          'admin.system.proxy.decision.excluded',
          'Direct — URL matches none of the URL patterns'
        );
      case 'disabled':
        return t('admin.system.proxy.decision.disabled', 'Direct — the proxy is switched off');
      default:
        return t('admin.system.proxy.decision.direct', 'Direct — no proxy configured for this URL');
    }
  };

  const classificationLabel = result => {
    const known = {
      ok: t('admin.system.proxy.classification.ok', 'Connection succeeded'),
      http_error: t('admin.system.proxy.classification.httpError', 'The target returned an error'),
      proxy_unreachable: t(
        'admin.system.proxy.classification.proxyUnreachable',
        'The proxy could not be reached'
      ),
      proxy_auth_required: t(
        'admin.system.proxy.classification.proxyAuthRequired',
        'The proxy requires authentication'
      ),
      proxy_dns_failure: t(
        'admin.system.proxy.classification.proxyDnsFailure',
        'The proxy host could not be resolved'
      ),
      dns_failure: t(
        'admin.system.proxy.classification.dnsFailure',
        'The target host could not be resolved'
      ),
      tls_failure: t('admin.system.proxy.classification.tlsFailure', 'TLS verification failed'),
      timeout: t('admin.system.proxy.classification.timeout', 'The request timed out'),
      target_unreachable: t(
        'admin.system.proxy.classification.targetUnreachable',
        'The target could not be reached'
      ),
      request_failed: t('admin.system.proxy.classification.requestFailed', 'The request failed')
    };
    return known[result.classification] || result.classification;
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
          {t('admin.system.proxy.title', 'Outbound Proxy')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  const inputClass =
    'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
      <div className="flex items-start mb-4">
        <Icon name="GlobeAltIcon" className="w-6 h-6 mr-2 text-blue-500 shrink-0" />
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.system.proxy.title', 'Outbound Proxy')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.system.proxy.description',
              'Route outbound traffic — LLM providers, web search, Jira, OIDC, MCP servers — through an HTTP(S) proxy. This is not the reverse-proxy login (proxyAuth) and not the trusted hop count (trustProxy).'
            )}
          </p>
        </div>
      </div>

      {/* What is in effect, before any of the fields below are read */}
      {status && (
        <div
          className={`flex items-start p-3 rounded-md mb-4 border text-sm ${
            status === 'active'
              ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200'
              : 'bg-gray-50 dark:bg-gray-700/40 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
          }`}
        >
          <Icon
            name={status === 'active' ? 'CheckCircleIcon' : 'InformationCircleIcon'}
            className="w-5 h-5 mr-2 shrink-0"
          />
          <p>
            {status === 'active' &&
              t(
                'admin.system.proxy.statusActive',
                'Outbound requests are routed through {{url}}.',
                {
                  url: effective.https || effective.http
                }
              )}
            {status === 'inactive' &&
              t(
                'admin.system.proxy.statusInactive',
                'No proxy is in use — no proxy URL is configured, so outbound requests go direct. Set a URL below to start using one.'
              )}
            {status === 'off' &&
              t(
                'admin.system.proxy.statusOff',
                'Proxying is switched off — outbound requests go direct, including any proxy set in the environment.'
              )}
          </p>
        </div>
      )}

      {message && (
        <div
          className={`p-4 rounded-md mb-4 ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
          }`}
        >
          <div className="flex">
            <Icon
              name={message.type === 'success' ? 'CheckCircleIcon' : 'ExclamationCircleIcon'}
              className={`w-5 h-5 mt-0.5 mr-3 ${
                message.type === 'success'
                  ? 'text-green-500 dark:text-green-400'
                  : 'text-red-500 dark:text-red-400'
              }`}
            />
            <p
              className={`text-sm ${
                message.type === 'success'
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }`}
            >
              {message.text}
            </p>
          </div>
        </div>
      )}

      {/* Enabled */}
      <div className="mb-6">
        <div className="flex items-start">
          <input
            id="proxy-enabled"
            type="checkbox"
            checked={config.enabled}
            onChange={e => setConfig(prev => ({ ...prev, enabled: e.target.checked }))}
            className="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            aria-describedby="proxy-enabled-hint"
          />
          <div className="ml-3">
            <label
              htmlFor="proxy-enabled"
              className="block text-sm font-medium text-gray-900 dark:text-gray-100 cursor-pointer"
            >
              {t('admin.system.proxy.enabled', 'Use a proxy for outbound requests')}
            </label>
            <p id="proxy-enabled-hint" className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t(
                'admin.system.proxy.enabledHint',
                'On its own this switch proxies nothing — a URL below has to be set. Switch it off to go direct even when a proxy is set in the environment.'
              )}{' '}
              {sourceLabel('enabled')}
            </p>
          </div>
        </div>
      </div>

      {/* Proxy URLs */}
      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        {['http', 'https'].map(field => (
          <div key={field}>
            <label
              htmlFor={`proxy-${field}`}
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {field === 'http'
                ? t('admin.system.proxy.httpUrl', 'Proxy for http:// targets')
                : t('admin.system.proxy.httpsUrl', 'Proxy for https:// targets')}
            </label>
            <input
              id={`proxy-${field}`}
              type="text"
              value={config[field]}
              onChange={e => setConfig(prev => ({ ...prev, [field]: e.target.value }))}
              placeholder={t(
                'admin.system.proxy.urlPlaceholder',
                'http://proxy.example.com:8080 or ${HTTPS_PROXY}'
              )}
              className={inputClass}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{sourceLabel(field)}</p>
            {unresolvedPlaceholders[field] && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                {t(
                  'admin.system.proxy.unresolvedPlaceholder',
                  '{{placeholder}} is not set in the environment, so no proxy is used for this scheme.',
                  { placeholder: unresolvedPlaceholders[field] }
                )}
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">
        {t(
          'admin.system.proxy.credentialsHint',
          'Credentials go in the URL (http://user:password@proxy.example.com:8080). Passwords are encrypted at rest and shown as ***REDACTED*** — leave the mask in place to keep the stored password.'
        )}
      </p>

      {/* No-proxy list */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
          {t('admin.system.proxy.noProxyTitle', 'Bypass the proxy for these hosts')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          {t(
            'admin.system.proxy.noProxyHelp',
            'Exact hostname (api.example.com), subdomains (.example.com or *.example.com). CIDR ranges, host:port entries and a bare * are not supported.'
          )}{' '}
          {sourceLabel('noProxy')}
        </p>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newNoProxy}
            onChange={e => setNewNoProxy(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addNoProxyEntry();
              }
            }}
            placeholder={t('admin.system.proxy.noProxyPlaceholder', 'localhost, .internal.company')}
            className={inputClass}
          />
          <button
            onClick={addNoProxyEntry}
            disabled={!newNoProxy.trim()}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed whitespace-nowrap"
          >
            <Icon name="PlusIcon" className="w-4 h-4 mr-1" />
            {t('admin.system.proxy.addEntry', 'Add')}
          </button>
        </div>
        {config.noProxy.length > 0 ? (
          <ul className="space-y-2">
            {config.noProxy.map(entry => (
              <li
                key={entry}
                className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-700 rounded-md"
              >
                <span className="text-sm text-gray-900 dark:text-gray-100 font-mono">{entry}</span>
                <button
                  onClick={() =>
                    setConfig(prev => ({
                      ...prev,
                      noProxy: prev.noProxy.filter(item => item !== entry)
                    }))
                  }
                  className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium"
                >
                  {t('admin.system.proxy.removeEntry', 'Remove')}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('admin.system.proxy.noProxyEmpty', 'No bypasses — every request uses the proxy.')}
          </p>
        )}
      </div>

      {/* URL patterns */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
          {t('admin.system.proxy.urlPatternsTitle', 'Proxy only URLs matching these patterns')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          {t(
            'admin.system.proxy.urlPatternsHelp',
            'Regular expressions tested against the full URL. Leave the list empty to proxy everything; with entries, only matching URLs are proxied.'
          )}{' '}
          {sourceLabel('urlPatterns')}
        </p>
        <div className="flex gap-2 mb-1">
          <input
            type="text"
            value={newPattern}
            onChange={e => setNewPattern(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addPattern();
              }
            }}
            placeholder={t('admin.system.proxy.urlPatternPlaceholder', 'api\\.openai\\.com')}
            className={`${inputClass} font-mono ${
              newPattern.trim() && !isValidRegex(newPattern.trim())
                ? 'border-red-400 dark:border-red-500'
                : ''
            }`}
          />
          <button
            onClick={addPattern}
            disabled={!newPattern.trim() || !isValidRegex(newPattern.trim())}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed whitespace-nowrap"
          >
            <Icon name="PlusIcon" className="w-4 h-4 mr-1" />
            {t('admin.system.proxy.addEntry', 'Add')}
          </button>
        </div>
        {newPattern.trim() && !isValidRegex(newPattern.trim()) && (
          <p className="text-xs text-red-600 dark:text-red-400 mb-2">
            {t('admin.system.proxy.invalidPattern', 'Not a valid regular expression')}
          </p>
        )}
        {config.urlPatterns.length > 0 ? (
          <ul className="space-y-2 mt-2">
            {config.urlPatterns.map(pattern => (
              <li
                key={pattern}
                className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-700 rounded-md"
              >
                <span className="text-sm text-gray-900 dark:text-gray-100 font-mono break-all">
                  {pattern}
                  {!isValidRegex(pattern) && (
                    <span className="ml-2 text-xs text-red-600 dark:text-red-400 font-sans">
                      {t('admin.system.proxy.invalidPattern', 'Not a valid regular expression')}
                    </span>
                  )}
                </span>
                <button
                  onClick={() =>
                    setConfig(prev => ({
                      ...prev,
                      urlPatterns: prev.urlPatterns.filter(item => item !== pattern)
                    }))
                  }
                  className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium ml-3 whitespace-nowrap"
                >
                  {t('admin.system.proxy.removeEntry', 'Remove')}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('admin.system.proxy.urlPatternsEmpty', 'No patterns — every URL uses the proxy.')}
          </p>
        )}
      </div>

      {/* Effective configuration */}
      {effective && (
        <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700/40 border border-gray-200 dark:border-gray-700 rounded-lg">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
            {t('admin.system.proxy.effectiveTitle', 'In effect right now')}
          </h3>
          <dl className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
            <div className="flex gap-2">
              <dt className="w-28 shrink-0">{t('admin.system.proxy.effectiveHttp', 'HTTP')}</dt>
              <dd className="font-mono break-all">
                {effective.http || t('admin.system.proxy.notSet', 'not set')}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0">{t('admin.system.proxy.effectiveHttps', 'HTTPS')}</dt>
              <dd className="font-mono break-all">
                {effective.https || t('admin.system.proxy.notSet', 'not set')}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0">
                {t('admin.system.proxy.effectiveNoProxy', 'No proxy')}
              </dt>
              <dd className="font-mono break-all">
                {effective.noProxy?.length
                  ? effective.noProxy.join(', ')
                  : t('admin.system.proxy.notSet', 'not set')}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {/* Save */}
      <div className="flex justify-end mb-8">
        <button
          onClick={handleSave}
          disabled={saving}
          className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white ${
            saving
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
          }`}
        >
          <Icon name="CheckIcon" className="w-4 h-4 mr-2" />
          {saving
            ? t('admin.system.proxy.savingConfig', 'Saving…')
            : t('admin.system.proxy.saveConfig', 'Save proxy settings')}
        </button>
      </div>

      {/* Connectivity test */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
          {t('admin.system.proxy.testTitle', 'Test connectivity')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          {t(
            'admin.system.proxy.testHelp',
            'Runs against the settings above, saved or not. No redirects are followed and no response body is fetched.'
          )}
        </p>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={testUrl}
            onChange={e => setTestUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !testing && testUrl.trim()) {
                e.preventDefault();
                handleTest();
              }
            }}
            placeholder={t(
              'admin.system.proxy.testUrlPlaceholder',
              'https://api.openai.com/v1/models'
            )}
            className={inputClass}
          />
          <button
            onClick={handleTest}
            disabled={testing || !testUrl.trim()}
            className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md shadow-xs text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            <Icon name="BoltIcon" className="w-4 h-4 mr-1" />
            {testing
              ? t('admin.system.proxy.testing', 'Testing…')
              : t('admin.system.proxy.testButton', 'Run test')}
          </button>
        </div>

        {testError && (
          <div className="p-4 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-700 dark:text-red-300">{testError}</p>
          </div>
        )}

        {testResult && (
          <div
            className={`p-4 rounded-md border ${
              testResult.ok
                ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
            }`}
          >
            <p
              className={`text-sm font-medium ${
                testResult.ok
                  ? 'text-green-800 dark:text-green-300'
                  : 'text-amber-800 dark:text-amber-300'
              }`}
            >
              {classificationLabel(testResult)}
            </p>
            <dl className="mt-2 text-xs text-gray-700 dark:text-gray-300 space-y-1">
              <div className="flex gap-2">
                <dt className="w-32 shrink-0">{t('admin.system.proxy.testRouting', 'Routing')}</dt>
                <dd>
                  {decisionLabel(testResult.routing?.decision)}
                  {testResult.routing?.proxyUrl ? (
                    <span className="font-mono"> — {testResult.routing.proxyUrl}</span>
                  ) : null}
                </dd>
              </div>
              {testResult.proxy && (
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0">{t('admin.system.proxy.testProxy', 'Proxy')}</dt>
                  <dd>
                    {testResult.proxy.reachable
                      ? t('admin.system.proxy.testProxyReachable', 'TCP connection established')
                      : t(
                          'admin.system.proxy.testProxyUnreachable',
                          'No TCP connection: {{error}}',
                          {
                            error: testResult.proxy.error || ''
                          }
                        )}
                  </dd>
                </div>
              )}
              {testResult.ssl?.ignoreInvalidCertificates && (
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0">{t('admin.system.proxy.testSsl', 'TLS')}</dt>
                  <dd>
                    {t(
                      'admin.system.proxy.testSslRelaxed',
                      'Certificate validation is switched off for this host by the SSL settings.'
                    )}
                  </dd>
                </div>
              )}
              {testResult.response && (
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0">
                    {t('admin.system.proxy.testResponse', 'Response')}
                  </dt>
                  <dd>
                    {testResult.response.status} {testResult.response.statusText}
                    {testResult.response.redirectLocation ? (
                      <span className="font-mono break-all">
                        {' '}
                        → {testResult.response.redirectLocation}
                      </span>
                    ) : null}
                  </dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="w-32 shrink-0">{t('admin.system.proxy.testTimings', 'Timing')}</dt>
                <dd>
                  {t('admin.system.proxy.testTimingValue', '{{total}} ms total', {
                    total: testResult.timings?.totalMs ?? 0
                  })}
                  {typeof testResult.timings?.proxyConnectMs === 'number'
                    ? t(
                        'admin.system.proxy.testTimingSplit',
                        ' ({{proxy}} ms proxy, {{request}} ms request)',
                        {
                          proxy: testResult.timings.proxyConnectMs,
                          request: testResult.timings.requestMs
                        }
                      )
                    : null}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0">{t('admin.system.proxy.testDetail', 'Detail')}</dt>
                <dd>{testResult.message}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0">
                  {t('admin.system.proxy.testNextStep', 'Next step')}
                </dt>
                <dd>{testResult.nextStep}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProxyConfig;
