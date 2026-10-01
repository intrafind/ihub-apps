import { useTranslation } from 'react-i18next';
import { CUSTOM_PROVIDER_API_TYPES } from '../../../../../shared/llmProviders.js';
import { apiTypeLabel } from '../utils/modelImport';

const INPUT =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white';
const READ_ONLY =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed';
const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2';
const HINT = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/**
 * Name, ID, description and — for LLM providers — API type and base URL of a
 * provider entry. Name and description are plain text; the ID is editable only
 * while creating.
 *
 * @param {Object} props
 * @param {Object} props.data - Provider form state
 * @param {(field: string, value: unknown) => void} props.onChange
 * @param {boolean} [props.isNew] - Creating: the ID is editable
 * @param {boolean} [props.isLlm] - Show API type and base URL
 * @param {boolean} [props.apiTypeLocked] - Built-in provider: its API type is its ID
 */
function ProviderFormFields({
  data,
  onChange,
  isNew = false,
  isLlm = false,
  apiTypeLocked = false
}) {
  const { t } = useTranslation();

  return (
    <>
      <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="provider-name" className={LABEL}>
            {t('admin.providers.fields.name', 'Name')} <span className="text-red-500">*</span>
          </label>
          <input
            id="provider-name"
            type="text"
            value={data.name}
            onChange={e => onChange('name', e.target.value)}
            placeholder="T-Systems LLM Hub"
            required
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="provider-id" className={LABEL}>
            {t('admin.providers.fields.id', 'ID')}{' '}
            {isNew && <span className="text-red-500">*</span>}
          </label>
          <input
            id="provider-id"
            type="text"
            value={data.id}
            onChange={e => onChange('id', e.target.value)}
            placeholder="t-systems-llm-hub"
            disabled={!isNew}
            required={isNew}
            className={isNew ? INPUT : READ_ONLY}
          />
          {isNew && (
            <p className={HINT}>
              {t(
                'admin.providers.create.idHelp',
                'Unique identifier (lowercase, use hyphens instead of spaces)'
              )}
            </p>
          )}
        </div>
      </div>

      <div className="mb-6">
        <label htmlFor="provider-description" className={LABEL}>
          {t('admin.providers.fields.description', 'Description')}
        </label>
        <textarea
          id="provider-description"
          value={data.description}
          onChange={e => onChange('description', e.target.value)}
          rows={2}
          className={`${INPUT} resize-none`}
        />
      </div>

      {isLlm && (
        <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="provider-api-type" className={LABEL}>
              {t('admin.providers.fields.apiType', 'API type')}
            </label>
            {apiTypeLocked ? (
              <input
                id="provider-api-type"
                type="text"
                value={apiTypeLabel(t, data.id)}
                disabled
                className={READ_ONLY}
              />
            ) : (
              <select
                id="provider-api-type"
                value={data.apiType || 'openai'}
                onChange={e => onChange('apiType', e.target.value)}
                className={INPUT}
              >
                {CUSTOM_PROVIDER_API_TYPES.map(type => (
                  <option key={type} value={type}>
                    {apiTypeLabel(t, type)}
                  </option>
                ))}
              </select>
            )}
            <p className={HINT}>
              {apiTypeLocked
                ? t(
                    'admin.providers.hints.apiTypeBuiltIn',
                    'Built-in providers always speak their own API.'
                  )
                : t(
                    'admin.providers.hints.apiType',
                    'Which API the endpoint speaks. Gateways such as T-Systems LLM Hub are OpenAI-compatible; choose vLLM for a self-hosted vLLM server.'
                  )}
            </p>
          </div>
          <div>
            <label htmlFor="provider-base-url" className={LABEL}>
              {t('admin.providers.fields.baseUrl', 'Base URL')}
            </label>
            <input
              id="provider-base-url"
              type="url"
              value={data.baseUrl || ''}
              onChange={e => onChange('baseUrl', e.target.value)}
              placeholder="https://llm-server.llmhub.t-systems.net/v2"
              className={INPUT}
            />
            <p className={HINT}>
              {t(
                'admin.providers.hints.baseUrl',
                'Optional. The API base the provider’s models are listed from when importing models.'
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

export default ProviderFormFields;
