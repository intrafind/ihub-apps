// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { LLM_TIMEOUT_KEYS, LLM_TIMEOUT_MAX_MS } from '../../../../../shared/llmProviders.js';

const INPUT =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white';
const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2';
const HINT = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/**
 * The transport ceilings of an LLM provider entry. An empty field inherits the
 * installation's value (shown as the placeholder); a model's own value still
 * wins over the provider's.
 *
 * @param {Object} props
 * @param {Object} props.data - Provider form state
 * @param {(field: string, value: number|undefined) => void} props.onChange
 * @param {Object} [props.inherited] - `{ connectTimeoutMs, streamIdleTimeoutMs }` the installation applies
 */
function ProviderTimeoutFields({ data, onChange, inherited = {} }) {
  const { t } = useTranslation();

  const fields = {
    connectTimeoutMs: t('admin.providers.timeouts.connect', 'Connect timeout (ms)'),
    streamIdleTimeoutMs: t('admin.providers.timeouts.streamIdle', 'Stream idle timeout (ms)')
  };

  return (
    <fieldset className="mb-6">
      <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('admin.providers.timeouts.providerTitle', 'Timeouts')}
      </legend>
      <p className={`${HINT} mb-3`}>
        {t(
          'admin.providers.timeouts.providerDescription',
          'Apply to all models of this provider. Leave a field empty to use the installation value; a model can still set its own. 0 turns a ceiling off.'
        )}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {LLM_TIMEOUT_KEYS.map(key => (
          <div key={key}>
            <label htmlFor={`provider-${key}`} className={LABEL}>
              {fields[key]}
            </label>
            <input
              id={`provider-${key}`}
              type="number"
              min="0"
              max={LLM_TIMEOUT_MAX_MS}
              step="1"
              value={data[key] ?? ''}
              placeholder={inherited[key] === undefined ? '' : String(inherited[key])}
              onChange={e =>
                onChange(key, e.target.value === '' ? undefined : Number(e.target.value))
              }
              aria-describedby={`provider-${key}-hint`}
              className={INPUT}
            />
            {inherited[key] !== undefined && (
              <p id={`provider-${key}-hint`} className={HINT}>
                {t('admin.providers.timeouts.inherited', 'Inherited: {{value}} ms (installation)', {
                  value: inherited[key]
                })}
              </p>
            )}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export default ProviderTimeoutFields;
