import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildApiUrl } from '../../utils/runtimeBasePath';
import { useAuth } from '../../shared/contexts/AuthContext';
import { usePlatformConfig } from '../../shared/contexts/PlatformConfigContext';
import LoginForm from '../auth/components/LoginForm';

const PROVIDERS = [
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Powerful AI models with a generous free tier — great for getting started.',
    badgeKey: 'setup.step2.freeTierBadge',
    placeholder: 'AIzaSy...',
    keyUrl: 'https://aistudio.google.com/app/apikey'
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Claude models excel at nuanced reasoning and long-context tasks.',
    placeholder: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models — the industry standard for a wide range of AI tasks.',
    placeholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Efficient, open-weight models with strong multilingual support.',
    placeholder: 'API key...',
    keyUrl: 'https://console.mistral.ai/api-keys/'
  },
  {
    id: 'local',
    name: 'Local Provider',
    description: 'LM Studio, Jan.ai, Ollama, vLLM — run models privately on your own hardware.',
    placeholder: 'API key (optional)...',
    keyUrl: null
  }
];

const TOTAL_STEPS = 4;

export default function SetupWizard() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, isAuthenticated, isLoading: authLoading, logout } = useAuth();
  const { platformConfig, refreshConfig } = usePlatformConfig();
  const [step, setStep] = useState(() => {
    const saved = sessionStorage.getItem('setup_wizard_step');
    return saved ? parseInt(saved, 10) : 1;
  }); // 1=welcome, 2=sign-in, 3=provider, 4=finish
  const [selectedProvider, setSelectedProvider] = useState(PROVIDERS[0]);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // null | { valid, error }
  const [error, setError] = useState(null);
  const [loginError, setLoginError] = useState(null);
  const [loginJustCompleted, setLoginJustCompleted] = useState(false);

  const userIsAdmin = user?.isAdmin === true;

  // Ensure authReturnUrl points to this page so the embedded login form does not
  // trigger a full-page redirect to the root URL in subpath deployments (e.g. nginx
  // with base path /ihub).  The root cause is a race condition: loadAuthStatus() may
  // store authReturnUrl as "/" (or "/ihub/") before SetupCheck has had a chance to
  // navigate to "/setup" (or "/ihub/setup").  By overwriting it here – once the
  // wizard is actually mounted at its own URL – we guarantee that loginLocal /
  // loginLdap will compare identical paths and skip the redirect.
  useEffect(() => {
    sessionStorage.setItem('authReturnUrl', window.location.href);
  }, []);

  // Persist wizard step to survive component remounts and redirects (e.g. OIDC/NTLM)
  useEffect(() => {
    if (step > 1 && step < TOTAL_STEPS) {
      sessionStorage.setItem('setup_wizard_step', String(step));
    } else {
      sessionStorage.removeItem('setup_wizard_step');
    }
  }, [step]);

  // Defensive recovery: if the wizard is restored at the login step (step 2) but
  // the user is already authenticated as an admin (e.g. after an unexpected redirect
  // caused a full-page reload), advance directly to the provider step (step 3).
  useEffect(() => {
    if (step === 2 && !authLoading && isAuthenticated && userIsAdmin) {
      setLoginError(null);
      setStep(3);
    }
  }, [step, authLoading, isAuthenticated, userIsAdmin]);

  // After login completes, check admin access and advance
  useEffect(() => {
    if (loginJustCompleted && !authLoading && isAuthenticated) {
      setLoginJustCompleted(false);
      if (user?.isAdmin) {
        setLoginError(null);
        setStep(3);
      } else {
        setLoginError(t('setup.step2Login.notAdmin'));
      }
    }
  }, [loginJustCompleted, authLoading, isAuthenticated, user, t]);

  // If already configured, skip the wizard — but only on the Welcome screen.
  // Once the user is past Welcome (login, provider config, finish), don't interrupt.
  useEffect(() => {
    if (step >= 2) return;
    if (platformConfig && (platformConfig.setup?.configured ?? true)) {
      navigate('/', { replace: true });
    }
  }, [platformConfig, navigate, step]);

  const isLocal = selectedProvider.id === 'local';

  const handleGetStarted = () => {
    if (!authLoading && isAuthenticated && userIsAdmin) {
      setStep(3); // skip login — already authenticated as admin
    } else {
      setStep(2); // show login step
    }
  };

  const handleLoginSuccess = () => {
    setLoginJustCompleted(true);
  };

  const handleSignOutAndRetry = async () => {
    setLoginError(null);
    await logout();
  };

  // Build headers for authenticated setup API calls.
  // Include the Authorization header as a fallback alongside the HTTP-only cookie
  // to ensure the JWT is transmitted even if the cookie is not forwarded (e.g. by
  // a reverse proxy or in certain SameSite/cross-port dev-server scenarios).
  const buildAuthHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    const authToken = localStorage.getItem('authToken');
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    return headers;
  };

  const handleTestKey = async () => {
    if (!apiKey.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(buildApiUrl('setup/test'), {
        method: 'POST',
        credentials: 'include',
        headers: buildAuthHeaders(),
        body: JSON.stringify({ providerId: selectedProvider.id, apiKey: apiKey.trim() })
      });
      const data = await response.json();
      setTestResult(data);
    } catch {
      setTestResult({ valid: false, error: t('setup.step2.testError') });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    // Local provider: key is optional; cloud providers require a key
    if (!isLocal && !apiKey.trim()) {
      setError(t('setup.step2.testFailed'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body =
        isLocal && !apiKey.trim()
          ? { providerId: 'local' }
          : { providerId: selectedProvider.id, apiKey: apiKey.trim() };

      const response = await fetch(buildApiUrl('setup/configure'), {
        method: 'POST',
        credentials: 'include',
        headers: buildAuthHeaders(),
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || t('setup.step2.testError'));
        return;
      }
      // Refresh platform config so setup.configured becomes true in memory,
      // then store a session fast-path flag in case the refresh hasn't settled
      // before the user clicks "Go to Apps".
      refreshConfig();
      sessionStorage.setItem('setup_configured', '1');
      setStep(4);
    } catch {
      setError(t('setup.step2.testError'));
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => {
    // Remember the skip for this session only so the wizard doesn't interrupt
    // again. Next session/tab will re-check with the server.
    sessionStorage.removeItem('setup_wizard_step');
    sessionStorage.setItem('setup_skipped', '1');
    navigate('/', { replace: true });
  };

  const handleFinish = () => {
    sessionStorage.removeItem('setup_wizard_step');
    navigate('/', { replace: true });
  };

  const handleGoToAdmin = () => {
    sessionStorage.removeItem('setup_wizard_step');
    navigate('/admin', { replace: true });
  };

  const progressWidth = `${(step / TOTAL_STEPS) * 100}%`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-lg">
        {/* Progress bar */}
        <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-t-2xl overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-500"
            style={{ width: progressWidth }}
          />
        </div>

        <div className="p-8">
          {/* Step 1: Welcome */}
          {step === 1 && (
            <div className="text-center">
              <div className="text-5xl mb-4">🚀</div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
                {t('setup.step1.title')}
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mb-8">
                {t('setup.step1.description')}
              </p>
              <button
                onClick={handleGetStarted}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors"
              >
                {t('setup.step1.getStarted')}
              </button>
              <button
                onClick={handleSkip}
                className="mt-3 w-full text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-2 transition-colors"
              >
                {t('setup.step1.skipLater')}
              </button>
            </div>
          )}

          {/* Step 2: Sign In */}
          {step === 2 && (
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">
                {t('setup.step2Login.title')}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                {t('setup.step2Login.description')}
              </p>

              {loginError && (
                <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800">
                  <p className="text-sm text-red-700 dark:text-red-300">{loginError}</p>
                  <button
                    onClick={handleSignOutAndRetry}
                    className="mt-2 text-sm font-medium text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 underline"
                  >
                    {t('setup.step2Login.signOutAndRetry')}
                  </button>
                </div>
              )}

              <LoginForm embedded onSuccess={handleLoginSuccess} />

              <button
                onClick={handleSkip}
                className="mt-3 w-full text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-2 transition-colors"
              >
                {t('setup.step1.skipLater')}
              </button>
            </div>
          )}

          {/* Step 3: Provider setup */}
          {step === 3 && (
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">
                {t('setup.step2.title')}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                {t('setup.step2.description')}
              </p>

              {/* Provider cards */}
              <div className="grid grid-cols-2 gap-2 mb-5">
                {PROVIDERS.map(provider => (
                  <button
                    key={provider.id}
                    onClick={() => {
                      setSelectedProvider(provider);
                      setApiKey('');
                      setError(null);
                      setTestResult(null);
                    }}
                    className={`relative text-left p-3 rounded-xl border-2 transition-all ${
                      selectedProvider.id === provider.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    {provider.badgeKey && (
                      <span className="absolute top-2 right-2 text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 px-1.5 py-0.5 rounded-full font-medium">
                        {t(provider.badgeKey)}
                      </span>
                    )}
                    <div className="font-semibold text-sm text-gray-900 dark:text-white mb-0.5 pr-12">
                      {provider.name}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 leading-snug">
                      {provider.description}
                    </div>
                  </button>
                ))}
              </div>

              {/* API key input */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('setup.step2.apiKeyLabel', { provider: selectedProvider.name })}
                    {isLocal && (
                      <span className="ml-1.5 text-xs font-normal text-gray-400">
                        {t('setup.step2.apiKeyOptional')}
                      </span>
                    )}
                  </label>
                  {selectedProvider.keyUrl && (
                    <a
                      href={selectedProvider.keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      {t('setup.step2.getApiKey')}
                    </a>
                  )}
                </div>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => {
                    setApiKey(e.target.value);
                    setError(null);
                    setTestResult(null);
                  }}
                  placeholder={selectedProvider.placeholder}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  autoComplete="off"
                />
                {isLocal && (
                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {t('setup.step2.localApiKeyHint')}
                  </p>
                )}

                {/* Test result feedback */}
                {testResult && (
                  <p
                    className={`mt-1.5 text-xs ${testResult.valid ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                  >
                    {testResult.valid
                      ? `✓ ${t('setup.step2.testSuccess')}`
                      : `✗ ${testResult.error || t('setup.step2.testFailed')}`}
                  </p>
                )}
                {error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>}
              </div>

              {/* Local provider info notice */}
              {isLocal && (
                <div className="mb-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800">
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {t('setup.step2.localNotice')}{' '}
                    <strong>{t('setup.step2.localNoticeLink')}</strong>{' '}
                    {t('setup.step2.localNoticeAfterSetup')}
                  </p>
                </div>
              )}

              {/* Test + action buttons */}
              <div className="flex gap-2 mb-3">
                {!isLocal && (
                  <button
                    onClick={handleTestKey}
                    disabled={testing || !apiKey.trim()}
                    className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-medium py-2.5 px-3 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                  >
                    {testing ? t('setup.step2.testingButton') : t('setup.step2.testButton')}
                  </button>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-medium py-2.5 px-4 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  {t('setup.step2.back')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || (!isLocal && !apiKey.trim())}
                  className="flex-[2] bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-semibold py-2.5 px-6 rounded-xl transition-colors"
                >
                  {saving
                    ? t('setup.step2.savingButton')
                    : isLocal
                      ? t('setup.step2.saveButtonLocal')
                      : t('setup.step2.saveButton')}
                </button>
              </div>

              <button
                onClick={handleSkip}
                className="mt-3 w-full text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-2 transition-colors"
              >
                {t('setup.step2.skipLater')}
              </button>
            </div>
          )}

          {/* Step 4: Finish */}
          {step === 4 && (
            <div>
              <div className="text-center mb-6">
                <div className="text-5xl mb-4">🎉</div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
                  {t('setup.step3.title')}
                </h2>
                <p className="text-gray-500 dark:text-gray-400">
                  {isLocal
                    ? t('setup.step3.subtitleLocal')
                    : t('setup.step3.subtitleCloud', { provider: selectedProvider.name })}
                </p>
              </div>

              {/* Next steps */}
              <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    {t('setup.step3.nextStepsTitle')}
                  </span>
                </div>
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {[
                    t('setup.step3.nextStep1'),
                    t('setup.step3.nextStep2'),
                    t('setup.step3.nextStep3'),
                    t('setup.step3.nextStep4')
                  ].map((item, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 px-4 py-3 text-sm text-gray-700 dark:text-gray-300"
                    >
                      <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 text-xs font-bold flex items-center justify-center">
                        {i + 1}
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleGoToAdmin}
                  className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-medium py-2.5 px-4 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  {t('setup.step3.goToAdmin')}
                </button>
                <button
                  onClick={handleFinish}
                  className="flex-[2] bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 px-6 rounded-xl transition-colors"
                >
                  {t('setup.step3.goToApps')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer step indicator */}
        <div className="flex justify-center gap-1.5 pb-5">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map(s => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                s === step
                  ? 'w-5 bg-blue-500'
                  : s < step
                    ? 'w-2.5 bg-blue-300'
                    : 'w-2.5 bg-gray-200 dark:bg-gray-700'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
