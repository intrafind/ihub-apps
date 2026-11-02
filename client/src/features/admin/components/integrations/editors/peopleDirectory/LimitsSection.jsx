// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { EditorSection, FieldError } from '../InstallationEditorParts';
import ChoiceField from './ChoiceField';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from '../../../formStyles';
import {
  FALLBACK_LIMIT_DEFAULTS,
  FALLBACK_LIMIT_MAXIMA,
  LIMIT_FIELDS,
  LIMIT_MINIMA,
  inputIdForField
} from '../peopleDirectoryEditorModel';

const K = 'admin.integrations.editors.peopleDirectory.limits';

/**
 * Section "Limits" of the People directory (LDAP) editor: result count, time
 * limit and the per-directory request queue, plus whether `list_units` is
 * offered. An empty field uses the default, which is shown next to it
 * together with the upper bound.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {Object} [props.defaults] - Defaults by field from the editor context
 * @param {Object} [props.limits] - Upper bounds by field from the editor context
 * @param {Object<string,string>} props.errors - Field errors by install field
 */
function LimitsSection({ form, update, defaults = {}, limits = {}, errors }) {
  const { t } = useTranslation();

  const labels = {
    maxResults: t(`${K}.maxResults`, 'Maximum results per search'),
    timeoutMs: t(`${K}.timeoutMs`, 'Timeout (ms)'),
    concurrency: t(`${K}.concurrency`, 'Parallel requests'),
    requestDelayMs: t(`${K}.requestDelayMs`, 'Delay between requests (ms)')
  };

  return (
    <EditorSection
      id="pd-limits"
      title={t(`${K}.title`, 'Limits')}
      description={t(
        `${K}.description`,
        'Upper bounds for each search. A tool call can ask for fewer results, never more. All tools of this directory, its test and the LDAP browsers that reuse it share one request queue.'
      )}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {LIMIT_FIELDS.map(field => {
          const inputId = inputIdForField(field);
          const min = LIMIT_MINIMA[field];
          const max = limits[field] ?? FALLBACK_LIMIT_MAXIMA[field];
          const fallback = defaults[field] ?? FALLBACK_LIMIT_DEFAULTS[field];
          const helpId = `${inputId}-help`;
          return (
            <div key={field}>
              <label htmlFor={inputId} className={LABEL_CLASS}>
                {labels[field]}
              </label>
              <input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                value={form[field]}
                onChange={e => update({ [field]: e.target.value })}
                placeholder={String(fallback)}
                aria-describedby={helpId}
                aria-invalid={errors[field] ? 'true' : undefined}
                className={INPUT_CLASS}
              />
              <p id={helpId} className={HELP_CLASS}>
                {t(`${K}.range`, 'Default {{fallback}}, {{min}} to {{max}}.', {
                  fallback,
                  min,
                  max
                })}
              </p>
              <FieldError message={errors[field]} />
            </div>
          );
        })}
      </div>

      <ChoiceField
        id="pd-units"
        type="checkbox"
        checked={form.units}
        onChange={units => update({ units })}
        label={t(`${K}.units`, 'Offer organisational units (list_units)')}
        help={t(
          `${K}.unitsHelp`,
          'Lists the units directly below the search base (for x500.bund.de: the authorities), so the model can narrow a search to one of them.'
        )}
      />
    </EditorSection>
  );
}

export default LimitsSection;
