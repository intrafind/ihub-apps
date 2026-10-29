// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import FormSection from './FormSection';
import ChoiceField from './ChoiceField';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from './formStyles';
import {
  FALLBACK_LIMIT_DEFAULTS,
  FALLBACK_LIMIT_MAXIMA,
  LIMIT_FIELDS,
  LIMIT_MINIMA
} from '../../utils/peopleDirectories';

/** Element ids of the limit inputs, matching FIELD_INPUT_IDS. */
const INPUT_IDS = {
  maxResults: 'pd-max-results',
  timeoutMs: 'pd-timeout-ms',
  concurrency: 'pd-concurrency',
  requestDelayMs: 'pd-request-delay-ms'
};

/**
 * Editor section "Limits": result count, time limit and the per-directory
 * request queue, plus whether `list_units` is offered. An empty field uses
 * the default, which is shown next to it together with the upper bound.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {Object} [props.defaults] - Defaults by field from the presets endpoint
 * @param {Object} [props.limits] - Upper bounds by field from the presets endpoint
 */
function LimitsSection({ form, update, defaults = {}, limits = {} }) {
  const { t } = useTranslation();

  const labels = {
    maxResults: t('admin.peopleDirectories.limits.maxResults', 'Maximum results per search'),
    timeoutMs: t('admin.peopleDirectories.limits.timeoutMs', 'Timeout (ms)'),
    concurrency: t('admin.peopleDirectories.limits.concurrency', 'Parallel requests'),
    requestDelayMs: t(
      'admin.peopleDirectories.limits.requestDelayMs',
      'Delay between requests (ms)'
    )
  };

  return (
    <FormSection
      id="pd-limits"
      title={t('admin.peopleDirectories.limits.title', 'Limits')}
      description={t(
        'admin.peopleDirectories.limits.description',
        'Upper bounds for each search. A tool call can ask for fewer results, never more. All tools of this directory and its test share one request queue.'
      )}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {LIMIT_FIELDS.map(field => {
          const min = LIMIT_MINIMA[field];
          const max = limits[field] ?? FALLBACK_LIMIT_MAXIMA[field];
          const fallback = defaults[field] ?? FALLBACK_LIMIT_DEFAULTS[field];
          const helpId = `${INPUT_IDS[field]}-help`;
          return (
            <div key={field}>
              <label htmlFor={INPUT_IDS[field]} className={LABEL_CLASS}>
                {labels[field]}
              </label>
              <input
                id={INPUT_IDS[field]}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                value={form[field]}
                onChange={e => update({ [field]: e.target.value })}
                placeholder={String(fallback)}
                aria-describedby={helpId}
                className={INPUT_CLASS}
              />
              <p id={helpId} className={HELP_CLASS}>
                {t(
                  'admin.peopleDirectories.limits.range',
                  'Default {{fallback}}, {{min}} to {{max}}.',
                  {
                    fallback,
                    min,
                    max
                  }
                )}
              </p>
            </div>
          );
        })}
      </div>

      <ChoiceField
        id="pd-units"
        type="checkbox"
        checked={form.units}
        onChange={units => update({ units })}
        label={t('admin.peopleDirectories.limits.units', 'Offer organisational units (list_units)')}
        help={t(
          'admin.peopleDirectories.limits.unitsHelp',
          'Lists the units directly below the search base (for x500.bund.de: the authorities), so the model can narrow a search to one of them.'
        )}
      />
    </FormSection>
  );
}

export default LimitsSection;
