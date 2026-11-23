// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import {
  CUSTOM_PROVIDER_API_TYPES,
  GATEWAY_API_TYPES,
  IFINDER_GATEWAY
} from '../../../../../shared/llmProviders.js';
import { apiTypeLabel } from '../utils/modelImport';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from './formStyles';
import RequiredMark from './RequiredMark';

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
  // A model gateway provider only offers the dialects of its OpenAI-compatible models.
  const apiTypes = data.gateway ? GATEWAY_API_TYPES : CUSTOM_PROVIDER_API_TYPES;

  const changeGateway = value => {
    onChange('gateway', value || undefined);
    if (value && !GATEWAY_API_TYPES.includes(data.apiType)) onChange('apiType', 'openai');
  };

  return (
    <>
      <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="provider-name" className={LABEL_CLASS}>
            {t('admin.providers.fields.name', 'Name')}
            <RequiredMark />
          </label>
          <input
            id="provider-name"
            type="text"
            value={data.name}
            onChange={e => onChange('name', e.target.value)}
            placeholder="T-Systems LLM Hub"
            required
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="provider-id" className={LABEL_CLASS}>
            {t('admin.providers.fields.id', 'ID')}
            {isNew && <RequiredMark />}
          </label>
          <input
            id="provider-id"
            type="text"
            value={data.id}
            onChange={e => onChange('id', e.target.value)}
            placeholder="t-systems-llm-hub"
            disabled={!isNew}
            required={isNew}
            aria-describedby={isNew ? 'provider-id-hint' : undefined}
            className={INPUT_CLASS}
          />
          {isNew && (
            <p id="provider-id-hint" className={HELP_CLASS}>
              {t(
                'admin.providers.create.idHelp',
                'Unique identifier (lowercase, use hyphens instead of spaces)'
              )}
            </p>
          )}
        </div>
      </div>

      <div className="mb-6">
        <label htmlFor="provider-description" className={LABEL_CLASS}>
          {t('admin.providers.fields.description', 'Description')}
        </label>
        <textarea
          id="provider-description"
          value={data.description}
          onChange={e => onChange('description', e.target.value)}
          rows={2}
          className={`${INPUT_CLASS} resize-none`}
        />
      </div>

      {isLlm && (
        <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="provider-api-type" className={LABEL_CLASS}>
              {t('admin.providers.fields.apiType', 'API type')}
            </label>
            {apiTypeLocked ? (
              <input
                id="provider-api-type"
                type="text"
                value={apiTypeLabel(t, data.id)}
                disabled
                className={INPUT_CLASS}
              />
            ) : (
              <select
                id="provider-api-type"
                value={data.apiType || 'openai'}
                onChange={e => onChange('apiType', e.target.value)}
                className={INPUT_CLASS}
              >
                {apiTypes.map(type => (
                  <option key={type} value={type}>
                    {apiTypeLabel(t, type)}
                  </option>
                ))}
              </select>
            )}
            <p className={HELP_CLASS}>
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
            <label htmlFor="provider-base-url" className={LABEL_CLASS}>
              {t('admin.providers.fields.baseUrl', 'Base URL')}
            </label>
            <input
              id="provider-base-url"
              type="url"
              value={data.baseUrl || ''}
              onChange={e => onChange('baseUrl', e.target.value)}
              placeholder="https://llm-server.llmhub.t-systems.net/v2"
              className={INPUT_CLASS}
            />
            <p className={HELP_CLASS}>
              {t(
                'admin.providers.hints.baseUrl',
                'Optional. The API base the provider’s models are listed from when importing models.'
              )}
            </p>
          </div>
          {!apiTypeLocked && (
            <div className="sm:col-span-2">
              <label htmlFor="provider-gateway" className={LABEL_CLASS}>
                {t('admin.providers.fields.gateway', 'Model gateway')}
              </label>
              <select
                id="provider-gateway"
                value={data.gateway || ''}
                onChange={e => changeGateway(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">
                  {t('admin.providers.gateway.none', 'None (regular endpoint)')}
                </option>
                <option value={IFINDER_GATEWAY}>
                  {t('admin.providers.gateway.ifinder', 'iFinder Model Gateway')}
                </option>
              </select>
              <p className={HELP_CLASS}>
                {t(
                  'admin.providers.hints.gateway',
                  'Choose iFinder Model Gateway when the base URL is a gateway. Models are then listed from /v1/gateway/models and called through /v1/gateway/proxy. The API key is the gateway project key.'
                )}
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default ProviderFormFields;
