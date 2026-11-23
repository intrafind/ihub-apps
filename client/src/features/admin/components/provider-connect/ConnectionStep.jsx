// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { GATEWAY_API_TYPES } from '../../../../../../shared/llmProviders.js';
import { apiTypeLabel } from '../../utils/modelImport';
import {
  BEDROCK_REGION_SUGGESTIONS,
  DEFAULT_BEDROCK_REGION
} from '../../../../../../shared/bedrockRegions.js';
import {
  SELF_HOSTED_SERVERS,
  envVarFor,
  newProviderIdProblem,
  regionProblem
} from '../../utils/providerConnect';
import { FIELD, HINT, LABEL, STEP_INTRO, STEP_TITLE } from './connectStyles';
import { tileName } from './VendorStep';

/** Example and guidance under the URL field, per tile. */
function urlHint(t, tile, form) {
  switch (tile.id) {
    case 'azure-openai':
      return t(
        'admin.providers.connect.connection.urlHintAzure',
        'The endpoint of your Azure OpenAI resource, for example https://my-resource.openai.azure.com/openai/v1. A deployment URL copied from Azure (…/chat/completions?api-version=…) works too.'
      );
    case 'openai-compatible':
      return t(
        'admin.providers.connect.connection.urlHintGateway',
        'The API base, usually ending in /v1, for example https://llm-server.llmhub.t-systems.net/v2. Its /models listing or a chat completions URL works too.'
      );
    case 'self-hosted': {
      const server = SELF_HOSTED_SERVERS.find(s => s.id === form.serverKind);
      return t(
        'admin.providers.connect.connection.urlHintSelfHosted',
        'The API base as the iHub server reaches it (not your browser), for example {{example}}.',
        { example: server?.urlPlaceholder || 'http://localhost:8000/v1' }
      );
    }
    case 'ifinder-gateway':
      return t(
        'admin.models.import.gatewayUrlHint',
        'The gateway root, for example https://gateway:9614. iHub reads /v1/gateway/models and calls the models through /v1/gateway/proxy. Enter the gateway project API key below if the gateway requires one.'
      );
    default:
      return null;
  }
}

/**
 * Step 2, the connection: provider name and id (for a new provider), the
 * endpoint with an example for this kind of service, and the key — with the
 * environment variable named that can hold it instead.
 *
 * @param {Object} props
 * @param {Object} props.tile
 * @param {Object} props.form - Connection form (`initialConnectionForm`)
 * @param {{ mode: string, provider?: Object }} props.target - `resolveTarget`
 * @param {Array<Object>} props.providers
 * @param {(field: string, value: string) => void} props.onChange
 */
function ConnectionStep({ tile, form, target, providers, onChange }) {
  const { t } = useTranslation();
  const isNew = target.mode === 'new';
  const keyStored = target.mode === 'existing' && target.provider.apiKeySet;
  const envVar = envVarFor(form, target);
  const idProblem = isNew && form.id ? newProviderIdProblem(form.id, providers) : null;
  const idProblemText = {
    required: null,
    invalid: t(
      'admin.models.import.errors.providerIdInvalid',
      'Use lowercase letters, numbers, dots, hyphens and underscores only.'
    ),
    reserved: t(
      'admin.models.import.errors.providerIdReserved',
      'This ID is the name of an API type. Choose another ID.'
    ),
    exists: t(
      'admin.providers.connect.connection.idExists',
      'A provider with this ID already exists. Choose another ID, or edit that provider under Providers.'
    )
  }[idProblem];
  const hint = urlHint(t, tile, form);
  const regionProblemText = {
    required: null,
    invalid: t(
      'admin.providers.connect.connection.regionInvalid',
      'Enter an AWS region code such as eu-central-1, or global.'
    )
  }[regionProblem(tile, form)];

  return (
    <div className="space-y-4">
      <div>
        <h2 className={STEP_TITLE}>
          {t('admin.providers.connect.connection.title', 'Connect {{provider}}', {
            provider: tileName(t, tile)
          })}
        </h2>
        <p className={STEP_INTRO}>
          {tile.region
            ? t(
                'admin.providers.connect.connection.introBedrock',
                'The AWS region iHub lists and calls the models in, and a Bedrock API key. Both are stored on the AWS Bedrock provider (the key encrypted) when you finish.'
              )
            : t(
                'admin.providers.connect.connection.intro',
                'Where iHub reaches the models, and the key it sends. Nothing is saved until the last step.'
              )}
        </p>
      </div>

      {isNew && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="connect-name" className={LABEL}>
              {t('admin.providers.fields.name', 'Name')} <span className="text-red-500">*</span>
            </label>
            <input
              id="connect-name"
              type="text"
              value={form.name}
              onChange={e => onChange('name', e.target.value)}
              placeholder={tile.id === 'openai-compatible' ? 'T-Systems LLM Hub' : undefined}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="connect-id" className={LABEL}>
              {t('admin.providers.fields.id', 'ID')} <span className="text-red-500">*</span>
            </label>
            <input
              id="connect-id"
              type="text"
              value={form.id}
              onChange={e => onChange('id', e.target.value)}
              aria-invalid={Boolean(idProblemText)}
              aria-describedby={idProblemText ? 'connect-id-problem' : undefined}
              className={FIELD}
            />
            {idProblemText && (
              <p id="connect-id-problem" className="mt-1 text-xs text-red-600 dark:text-red-400">
                {idProblemText}
              </p>
            )}
          </div>
        </div>
      )}

      {tile.selfHosted && (
        <div>
          <label htmlFor="connect-server-kind" className={LABEL}>
            {t('admin.providers.connect.connection.serverKind', 'Server')}
          </label>
          <select
            id="connect-server-kind"
            value={form.serverKind}
            onChange={e => onChange('serverKind', e.target.value)}
            className={FIELD}
          >
            {SELF_HOSTED_SERVERS.map(server => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
          <p className={HINT}>
            {t(
              'admin.providers.connect.connection.serverKindHint',
              'vLLM is called with the vLLM adapter; LM Studio and Ollama with the OpenAI-compatible one.'
            )}
          </p>
        </div>
      )}

      {tile.gateway && (
        <div>
          <label htmlFor="connect-gateway-api-type" className={LABEL}>
            {t('admin.providers.fields.apiType', 'API type')}
          </label>
          <select
            id="connect-gateway-api-type"
            value={form.gatewayApiType}
            onChange={e => onChange('gatewayApiType', e.target.value)}
            className={FIELD}
          >
            {GATEWAY_API_TYPES.map(type => (
              <option key={type} value={type}>
                {apiTypeLabel(t, type)}
              </option>
            ))}
          </select>
        </div>
      )}

      {tile.region && (
        <div>
          <label htmlFor="connect-region" className={LABEL}>
            {t('admin.providers.connect.connection.region', 'AWS region')}{' '}
            <span className="text-red-500">*</span>
          </label>
          <input
            id="connect-region"
            type="text"
            list="connect-region-suggestions"
            autoComplete="off"
            spellCheck={false}
            value={form.region}
            onChange={e => onChange('region', e.target.value)}
            placeholder={DEFAULT_BEDROCK_REGION}
            aria-invalid={Boolean(regionProblemText)}
            aria-describedby={
              regionProblemText
                ? 'connect-region-problem connect-region-hint'
                : 'connect-region-hint'
            }
            className={FIELD}
          />
          <datalist id="connect-region-suggestions">
            {BEDROCK_REGION_SUGGESTIONS.map(region => (
              <option key={region} value={region} />
            ))}
          </datalist>
          {regionProblemText && (
            <p id="connect-region-problem" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {regionProblemText}
            </p>
          )}
          <p id="connect-region-hint" className={HINT}>
            {t(
              'admin.providers.connect.connection.regionHint',
              'An AWS region code such as eu-central-1, or "global" for the global cross-region inference profiles. Models that need an inference profile are offered with the profile of this region (eu. for eu-central-1).'
            )}
          </p>
        </div>
      )}

      {!tile.region && (
        <div>
          <label htmlFor="connect-url" className={LABEL}>
            {t('admin.models.import.url', 'Endpoint URL')} <span className="text-red-500">*</span>
          </label>
          <input
            id="connect-url"
            type="url"
            value={form.url}
            readOnly={tile.urlFixed}
            onChange={e => onChange('url', e.target.value)}
            placeholder={
              tile.selfHosted
                ? SELF_HOSTED_SERVERS.find(s => s.id === form.serverKind)?.urlPlaceholder
                : tile.urlPlaceholder
            }
            className={`${FIELD} ${tile.urlFixed ? 'bg-gray-50 dark:bg-gray-800' : ''}`}
          />
          {tile.urlFixed ? (
            <p className={HINT}>
              {t(
                'admin.providers.connect.connection.urlFixedHint',
                "The vendor's public API. Use the OpenAI-compatible gateway tile for a proxy in front of it."
              )}
            </p>
          ) : (
            hint && <p className={HINT}>{hint}</p>
          )}
        </div>
      )}

      <div>
        <label htmlFor="connect-key" className={LABEL}>
          {t('admin.models.import.apiKey', 'API key')}
        </label>
        <input
          id="connect-key"
          type="password"
          autoComplete="off"
          value={form.apiKey}
          onChange={e => onChange('apiKey', e.target.value)}
          placeholder={
            keyStored
              ? t(
                  'admin.providers.connect.connection.keyStoredPlaceholder',
                  'Stored — leave empty to keep it'
                )
              : tile.keyPlaceholder || undefined
          }
          className={FIELD}
        />
        <p className={HINT}>
          {keyStored
            ? t(
                'admin.providers.connect.connection.keyStoredHint',
                'A key is already stored on this provider. Leave the field empty to test and keep it, or enter a new one to replace it.'
              )
            : tile.selfHosted
              ? t(
                  'admin.providers.connect.connection.keyHintSelfHosted',
                  'Leave empty if the server has no authentication. A key entered here is stored encrypted on the provider.'
                )
              : t(
                  'admin.providers.connect.connection.keyHint',
                  'Stored encrypted on the provider, not on each model.'
                )}{' '}
          {/* Only for a provider that exists: the connection test of a new one reads no
              environment variable (the server looks one up only by a stored provider id). */}
          {envVar &&
            !isNew &&
            t(
              'admin.providers.connect.connection.envVarHint',
              'Instead of storing it, you can leave this empty and set the environment variable {{envVar}} on the server.',
              { envVar }
            )}
        </p>
        {tile.keyUrl && (
          <a
            href={tile.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {t('admin.providers.connect.connection.getKey', 'Where do I get a key?')}
          </a>
        )}
      </div>
    </div>
  );
}

export default ConnectionStep;
