import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildApiUrl } from '../../utils/runtimeBasePath';

const PROVIDERS = [
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Powerful AI models with a generous free tier — great for getting started.',
    badge: 'Free Tier',
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
  }
];

export default function SetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1); // 1=welcome, 2=provider, 3=done
  const [selectedProvider, setSelectedProvider] = useState(PROVIDERS[0]);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // If already configured, skip the wizard
  useEffect(() => {
    fetch(buildApiUrl('/api/setup/status'), { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.configured) {
          navigate('/', { replace: true });
        }
      })
      .catch(() => {
        // If the check fails, show the wizard anyway
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError('Please enter an API key.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(buildApiUrl('/api/setup/configure'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: selectedProvider.id, apiKey: apiKey.trim() })
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Failed to save API key. Please try again.');
        return;
      }
      // Mark setup as done in session so the guard doesn't re-check
      sessionStorage.setItem('setup_configured', '1');
      setStep(3);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => {
    sessionStorage.setItem('setup_configured', '1');
    navigate('/', { replace: true });
  };

  const handleFinish = () => {
    navigate('/', { replace: true });
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
                Welcome to iHub Apps
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mb-8">
                Your all-in-one platform for AI-powered applications. To get started, connect your
                first AI provider — it only takes a minute.
              </p>
              <button
                onClick={() => setStep(2)}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors"
              >
                Get Started
              </button>
              <button
                onClick={handleSkip}
                className="mt-3 w-full text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-2 transition-colors"
              >
                Skip, I&rsquo;ll configure later
              </button>
            </div>
          )}

          {/* Step 2: Provider setup */}
          {step === 2 && (
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">
                Connect your first AI provider
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                Select a provider and paste your API key below.
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
                    }}
                    className={`relative text-left p-3 rounded-xl border-2 transition-all ${
                      selectedProvider.id === provider.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    {provider.badge && (
                      <span className="absolute top-2 right-2 text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 px-1.5 py-0.5 rounded-full font-medium">
                        {provider.badge}
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
                    {selectedProvider.name} API Key
                  </label>
                  <a
                    href={selectedProvider.keyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-500 hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    Get API key →
                  </a>
                </div>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => {
                    setApiKey(e.target.value);
                    setError(null);
                  }}
                  placeholder={selectedProvider.placeholder}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  autoComplete="off"
                />
                {error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-medium py-2.5 px-4 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !apiKey.trim()}
                  className="flex-2 flex-grow bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-semibold py-2.5 px-6 rounded-xl transition-colors"
                >
                  {saving ? 'Saving…' : 'Save & Continue'}
                </button>
              </div>

              <button
                onClick={handleSkip}
                className="mt-3 w-full text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-2 transition-colors"
              >
                Skip, I&rsquo;ll configure later
              </button>
            </div>
          )}

          {/* Step 3: Done */}
          {step === 3 && (
            <div className="text-center">
              <div className="text-5xl mb-4">✅</div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
                You&rsquo;re all set!
              </h2>
              <p className="text-gray-500 dark:text-gray-400 mb-8">
                Your {selectedProvider.name} API key has been saved. You can now use AI-powered
                apps. More providers can be added under Admin &rsaquo; Providers.
              </p>
              <button
                onClick={handleFinish}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors"
              >
                Go to Apps
              </button>
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
