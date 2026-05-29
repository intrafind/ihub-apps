import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import SSLConfig from '../components/SSLConfig';
import CorsConfig from '../components/CorsConfig';
import CookieSettingsConfig from '../components/CookieSettingsConfig';
import AdminSettingsPage from '../components/AdminSettingsPage';
import { makeAdminApiCall } from '../../../api/adminApi';

function AdminSecurityPage() {
  const { t } = useTranslation();
  const [encryptValue, setEncryptValue] = useState('');
  const [encryptedResult, setEncryptedResult] = useState('');
  const [encryptLoading, setEncryptLoading] = useState(false);
  const [encryptMessage, setEncryptMessage] = useState('');

  const handleEncryptValue = async () => {
    if (!encryptValue || encryptValue.trim() === '') {
      setEncryptMessage({
        type: 'error',
        text: t('admin.system.encryptEmptyError', 'Please enter a value to encrypt')
      });
      return;
    }

    setEncryptLoading(true);
    setEncryptMessage('');
    setEncryptedResult('');

    try {
      const response = await makeAdminApiCall('/admin/encrypt-value', {
        method: 'POST',
        body: JSON.stringify({ value: encryptValue }),
        headers: { 'Content-Type': 'application/json' }
      });
      const data = response.data;
      setEncryptedResult(data.encryptedValue);
      setEncryptMessage({
        type: 'success',
        text: t('admin.system.encryptSuccess', 'Value encrypted successfully')
      });
    } catch (error) {
      setEncryptMessage({
        type: 'error',
        text: t('admin.system.encryptError', 'Failed to encrypt value: {{error}}', {
          error: error.message
        })
      });
    } finally {
      setEncryptLoading(false);
    }
  };

  const handleCopyEncrypted = async () => {
    if (!encryptedResult) return;
    try {
      await navigator.clipboard.writeText(encryptedResult);
      setEncryptMessage({
        type: 'success',
        text: t('admin.system.copiedToClipboard', 'Copied to clipboard!')
      });
    } catch {
      setEncryptMessage({
        type: 'error',
        text: t('admin.system.copyError', 'Failed to copy to clipboard')
      });
    }
  };

  const encryptionSection = (
    <div className="space-y-6">
      {/* Value Encryption Tool */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start space-x-4">
          <div className="flex-shrink-0 mt-1">
            <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/50">
              <Icon name="shield-check" size="lg" className="text-blue-600 dark:text-blue-400" />
            </div>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
              {t('admin.system.encryptTitle', 'Value Encryption Tool')}
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              {t(
                'admin.system.encryptDesc',
                'Encrypt sensitive values (passwords, API keys, secrets) to store them securely in .env files or configuration. The encrypted values will be automatically decrypted when loaded by the application.'
              )}
            </p>

            <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-4 mb-4">
              <div className="flex">
                <Icon name="information-circle" size="md" className="text-amber-500 mt-0.5 mr-3" />
                <div>
                  <h4 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {t('admin.system.encryptInfoTitle', 'Usage Instructions')}
                  </h4>
                  <ul className="text-sm text-amber-700 dark:text-amber-300 mt-1 space-y-1">
                    <li>
                      {t(
                        'admin.system.encryptInfo1',
                        '1. Enter your plaintext value (password, API key, etc.)'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.system.encryptInfo2',
                        '2. Click "Encrypt Value" to generate an encrypted version'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.system.encryptInfo3',
                        '3. Copy the encrypted value (starts with ENC[...])'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.system.encryptInfo4',
                        '4. Store it in your .env file or configuration'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.system.encryptInfo5',
                        '5. The application will automatically decrypt it at runtime'
                      )}
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            {encryptMessage && (
              <div
                className={`p-4 rounded-md mb-4 ${
                  encryptMessage.type === 'success'
                    ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                    : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
                }`}
              >
                <div className="flex">
                  <Icon
                    name={encryptMessage.type === 'success' ? 'check' : 'warning'}
                    size="md"
                    className={`mt-0.5 mr-3 ${encryptMessage.type === 'success' ? 'text-green-500' : 'text-red-500'}`}
                  />
                  <p
                    className={`text-sm ${encryptMessage.type === 'success' ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}
                  >
                    {encryptMessage.text}
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="encryptValue"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
                >
                  {t('admin.system.encryptInputLabel', 'Plaintext Value to Encrypt')}
                </label>
                <input
                  type="password"
                  id="encryptValue"
                  value={encryptValue}
                  onChange={e => setEncryptValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !encryptLoading) handleEncryptValue();
                  }}
                  className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  placeholder={t(
                    'admin.system.encryptInputPlaceholder',
                    'Enter value to encrypt (password, API key, etc.)'
                  )}
                  disabled={encryptLoading}
                />
              </div>

              <button
                onClick={handleEncryptValue}
                disabled={encryptLoading || !encryptValue}
                className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white ${
                  encryptLoading || !encryptValue
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
                }`}
              >
                {encryptLoading ? (
                  <>
                    <svg
                      className="animate-spin -ml-1 mr-3 h-4 w-4 text-white"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    {t('admin.system.encrypting', 'Encrypting...')}
                  </>
                ) : (
                  <>
                    <Icon name="shield-check" size="md" className="mr-2" />
                    {t('admin.system.encryptButton', 'Encrypt Value')}
                  </>
                )}
              </button>

              {encryptedResult && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.system.encryptedValueLabel', 'Encrypted Value')}
                  </label>
                  <div className="relative">
                    <textarea
                      readOnly
                      value={encryptedResult}
                      className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-xs sm:text-sm"
                      rows={4}
                      onClick={e => e.target.select()}
                    />
                    <button
                      onClick={handleCopyEncrypted}
                      className="absolute top-2 right-2 inline-flex items-center px-3 py-1 border border-gray-300 dark:border-gray-600 shadow-sm text-xs font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 hover:bg-gray-50 dark:hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                      <Icon name="clipboard" size="sm" className="mr-1" />
                      {t('admin.system.copyButton', 'Copy')}
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.system.encryptedValueHint',
                      'Use this encrypted value in your .env file or configuration. It will be automatically decrypted at runtime.'
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <AdminSettingsPage
      title={t('admin.nav.security', 'Security')}
      description={t(
        'admin.security.description',
        'SSL, CORS, cookie settings, and encryption configuration'
      )}
      sections={[
        {
          id: 'ssl',
          label: t('admin.security.sections.ssl', 'SSL / TLS'),
          children: <SSLConfig />
        },
        {
          id: 'cookies',
          label: t('admin.security.sections.cookies', 'Cookies'),
          children: <CookieSettingsConfig />
        },
        {
          id: 'cors',
          label: t('admin.security.sections.cors', 'CORS'),
          children: <CorsConfig />
        },
        {
          id: 'encryption',
          label: t('admin.security.sections.encryption', 'Value Encryption'),
          children: encryptionSection
        }
      ]}
    />
  );
}

export default AdminSecurityPage;
