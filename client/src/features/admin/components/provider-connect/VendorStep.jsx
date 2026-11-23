// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { STEP_INTRO, STEP_TITLE } from './connectStyles';

/**
 * Translated one-line description per tile. Vendor names are product names
 * and stay as they are.
 */
function tileDescriptions(t) {
  return {
    openai: t('admin.providers.connect.tiles.openai', 'GPT models from api.openai.com.'),
    'azure-openai': t(
      'admin.providers.connect.tiles.azureOpenai',
      'OpenAI models deployed in your Azure resource.'
    ),
    anthropic: t(
      'admin.providers.connect.tiles.anthropic',
      'Claude models from api.anthropic.com.'
    ),
    google: t('admin.providers.connect.tiles.google', 'Gemini models from the Google AI API.'),
    mistral: t('admin.providers.connect.tiles.mistral', 'Mistral models from api.mistral.ai.'),
    bedrock: t(
      'admin.providers.connect.tiles.bedrock',
      'Foundation models through the Bedrock Converse API.'
    ),
    openrouter: t(
      'admin.providers.connect.tiles.openrouter',
      'One API for models of many vendors.'
    ),
    'openai-compatible': t(
      'admin.providers.connect.tiles.openaiCompatible',
      'A gateway such as T-Systems LLM Hub or LiteLLM.'
    ),
    'self-hosted': t(
      'admin.providers.connect.tiles.selfHosted',
      'vLLM, LM Studio or Ollama on your own hardware.'
    ),
    'ifinder-gateway': t(
      'admin.providers.connect.tiles.ifinderGateway',
      'The model gateway of an iFinder installation.'
    )
  };
}

/** Tile names that are not product names. */
function tileNames(t) {
  return {
    'openai-compatible': t(
      'admin.providers.connect.tiles.openaiCompatibleName',
      'OpenAI-compatible gateway'
    ),
    'self-hosted': t('admin.providers.connect.tiles.selfHostedName', 'Self-hosted')
  };
}

/** Display name of a tile, translated where it is not a product name. */
export function tileName(t, tile) {
  return tileNames(t)[tile.id] || tile.name;
}

/**
 * Step 1, "Where are your models?": one tile per kind of endpoint the platform
 * can serve. The tile already connected (a shipped provider with a key) says so.
 *
 * @param {Object} props
 * @param {Array<Object>} props.tiles - Available tiles (`getAvailableTiles`)
 * @param {Array<Object>} props.providers - `GET /admin/providers` items
 * @param {string|null} props.selectedId
 * @param {(tileId: string) => void} props.onSelect
 */
function VendorStep({ tiles, providers, selectedId, onSelect }) {
  const { t } = useTranslation();
  const descriptions = tileDescriptions(t);
  const keyed = new Set((providers || []).filter(p => p.apiKeySet).map(p => p.id));

  return (
    <div>
      <h2 className={STEP_TITLE}>
        {t('admin.providers.connect.vendor.title', 'Where are your models?')}
      </h2>
      <p className={STEP_INTRO}>
        {t(
          'admin.providers.connect.vendor.intro',
          'Pick the service that runs your models. You can connect more providers later.'
        )}
      </p>
      <div
        role="radiogroup"
        aria-label={t('admin.providers.connect.vendor.title', 'Where are your models?')}
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {tiles.map(tile => {
          const selected = tile.id === selectedId;
          return (
            <button
              key={tile.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`connect-tile-${tile.id}`}
              onClick={() => onSelect(tile.id)}
              className={`rounded-lg p-4 text-left transition-colors focus:outline-hidden focus:ring-2 focus:ring-indigo-500 ${
                selected
                  ? 'border-2 border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30'
                  : 'border-2 border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-700'
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {tileName(t, tile)}
                </span>
                {tile.providerId && keyed.has(tile.providerId) && (
                  <span className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-900/50 px-2 py-0.5 text-xs font-medium text-green-800 dark:text-green-300">
                    {t('admin.providers.connect.vendor.keyStored', 'Key stored')}
                  </span>
                )}
              </span>
              <span className="mt-1 block text-xs text-gray-600 dark:text-gray-400">
                {descriptions[tile.id] || tile.description}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-gray-600 dark:text-gray-400">
        {t(
          'admin.providers.connect.vendor.otherProvider',
          'Need a provider that only holds custom credentials, or want to set every field yourself?'
        )}{' '}
        <Link
          to="/admin/providers/new"
          className="text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          {t('admin.providers.connect.vendor.otherProviderLink', 'Use the provider form')}
        </Link>
      </p>
    </div>
  );
}

export default VendorStep;
