import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildApiUrl, buildPath } from '../../utils/runtimeBasePath';
import { useAuth } from '../../shared/contexts/AuthContext';
import { usePlatformConfig } from '../../shared/contexts/PlatformConfigContext';

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
    badgeKey: 'setup.step2.noApiKeyBadge',
    placeholder: 'API key (optional)...',
    keyUrl: null
  }
];

export default function SetupWizard() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { platformConfig, refreshConfig } = usePlatformConfig();
  const [step, setStep] = useState(1); // 1=welcome, 2=provider, 3=finish
  const [selectedProvider, setSelectedProvider] = useState(PROVIDERS[0]);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // null | { valid, error }
  const [error, setError] = useState(null);

  // Setup requires real authentication — redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      const setupPath = buildPath('setup');
      navigate(`/login?returnUrl=${encodeURIComponent(setupPath)}`, { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate]);

  // If already configured, skip the wizard
  useEffect(() => {
    if (platformConfig && (platformConfig.setup?.configured ?? true)) {
      navigate('/', { replace: true });
    }
  }, [platformConfig, navigate]);

  const isLocal = selectedProvider.id === 'local';

  const handleTestKey = async () => {
    if (!apiKey.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(buildApiUrl('setup/test'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
      setStep(3);
    } catch {
      setError(t('setup.step2.testError'));
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => {
    // Remember the skip for this session only so the wizard doesn't interrupt
    // again. Next session/tab will re-check with the server.
    sessionStorage.setItem('setup_skipped', '1');
    navigate('/', { replace: true });
  };

  const handleFinish = () => {
    navigate('/', { replace: true });
  };

  const handleGoToAdmin = () => {
    navigate('/admin', { replace: true });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-lg">
        {/* Progress bar */}
        <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-t-2xl overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-500"
            style={{ width: step === 1 ? '33%' : step === 2 ? '66%' : '100%' }}
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
                onClick={() => setStep(2)}
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

          {/* Step 2: Provider setup */}
          {step === 2 && (
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

          {/* Step 3: Finish */}
          {step === 3 && (
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
          {[1, 2, 3].map(s => (
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
