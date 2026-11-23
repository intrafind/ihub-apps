// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import {
  BEDROCK_REGION_SUGGESTIONS,
  DEFAULT_BEDROCK_REGION,
  isValidBedrockRegion
} from '../../../../../shared/bedrockRegions.js';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from './formStyles';

/**
 * The AWS region of the AWS Bedrock provider (`config.region` in
 * providers.json). Every Bedrock model without a region of its own is listed
 * and called in it. Empty means "not set here": the server then uses
 * `AWS_REGION` / `AWS_DEFAULT_REGION`, else eu-central-1.
 *
 * @param {Object} props
 * @param {Object} props.data - Provider form state (`config.region`)
 * @param {(field: string, value: Object|undefined) => void} props.onChange - Receives `('config', nextConfig)`
 */
function BedrockRegionField({ data, onChange }) {
  const { t } = useTranslation();
  const region = data.config?.region ?? '';
  const invalid = region.trim() !== '' && !isValidBedrockRegion(region.trim());

  const setRegion = value => {
    const { region: _previous, ...rest } = data.config || {};
    const next = value === '' ? rest : { ...rest, region: value };
    onChange('config', Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div className="mb-6">
      <label htmlFor="provider-bedrock-region" className={LABEL_CLASS}>
        {t('admin.providers.bedrockRegion.label', 'AWS region')}
      </label>
      <input
        id="provider-bedrock-region"
        type="text"
        list="provider-bedrock-region-suggestions"
        autoComplete="off"
        spellCheck={false}
        value={region}
        onChange={e => setRegion(e.target.value)}
        placeholder={DEFAULT_BEDROCK_REGION}
        aria-invalid={invalid}
        aria-describedby={
          invalid
            ? 'provider-bedrock-region-problem provider-bedrock-region-hint'
            : 'provider-bedrock-region-hint'
        }
        className={INPUT_CLASS}
      />
      <datalist id="provider-bedrock-region-suggestions">
        {BEDROCK_REGION_SUGGESTIONS.map(value => (
          <option key={value} value={value} />
        ))}
      </datalist>
      {invalid && (
        <p
          id="provider-bedrock-region-problem"
          className="mt-1 text-xs text-red-600 dark:text-red-400"
        >
          {t(
            'admin.providers.bedrockRegion.invalid',
            'Enter an AWS region code such as eu-central-1, or global.'
          )}
        </p>
      )}
      <p id="provider-bedrock-region-hint" className={HELP_CLASS}>
        {t(
          'admin.providers.bedrockRegion.hint',
          'Region the Bedrock models are called in, unless a model sets its own. Leave empty to use AWS_REGION on the server (default eu-central-1). Models whose ID starts with a profile prefix (eu., us., global.) only work in a region of that geography.'
        )}
      </p>
    </div>
  );
}

export default BedrockRegionField;
