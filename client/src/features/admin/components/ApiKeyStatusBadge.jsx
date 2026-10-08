import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * What the server says about a model's or provider's API key, as a badge.
 *
 * `ok` and `keyless` are fine; `undecryptable` is the one that needs action
 * even though a key looks configured — it is stored, but under an encryption
 * key this server does not have — and `missing` is the plain "no key" case.
 * Renders nothing without a status (still loading, or a model type the check
 * does not cover).
 *
 * @param {Object} props
 * @param {{state: string, source: string, envVar: string|null}} [props.status]
 * @param {boolean} [props.detailed] - Add a line saying what to do (for forms)
 */
export default function ApiKeyStatusBadge({ status, detailed = false }) {
  const { t } = useTranslation();
  if (!status?.state) return null;

  const sourceLabel =
    status.source === 'env'
      ? t('admin.apiKeyStatus.source.env', 'environment variable {{envVar}}', {
          envVar: status.envVar
        })
      : status.source === 'provider'
        ? t('admin.apiKeyStatus.source.provider', 'stored on the provider')
        : t('admin.apiKeyStatus.source.model', 'stored on the model');

  const variants = {
    ok: {
      icon: 'KeyIcon',
      classes: 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200',
      label: t('admin.apiKeyStatus.ok', 'Key found'),
      hint: sourceLabel
    },
    keyless: {
      icon: 'check-circle',
      classes: 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200',
      label: t('admin.apiKeyStatus.keyless', 'No key needed'),
      hint: t(
        'admin.apiKeyStatus.keylessHint',
        'No key is set, so the server is called without an Authorization header.'
      )
    },
    undecryptable: {
      icon: 'ExclamationTriangleIcon',
      classes: 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200',
      label: t('admin.apiKeyStatus.undecryptable', 'Stored key unreadable'),
      hint: t(
        'admin.apiKeyStatus.undecryptableHint',
        'A key is stored, but this server cannot decrypt it: the encryption key changed since it was saved. Enter the key again, or make sure every instance uses the same TOKEN_ENCRYPTION_KEY / contents/.encryption-key.'
      )
    },
    missing: {
      icon: 'ExclamationTriangleIcon',
      classes: 'bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200',
      label: t('admin.apiKeyStatus.missing', 'No API key'),
      hint: t(
        'admin.apiKeyStatus.missingHint',
        'Enter a key here or on the provider, or set it as an environment variable.'
      )
    }
  };

  const variant = variants[status.state];
  if (!variant) return null;

  return (
    <div>
      <span
        className={`inline-flex items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-xs font-medium ${variant.classes}`}
        title={variant.hint}
        data-testid="api-key-status"
        data-state={status.state}
      >
        <Icon name={variant.icon} className="w-3 h-3 mr-1" />
        {variant.label}
      </span>
      {detailed && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{variant.hint}</p>
      )}
    </div>
  );
}
