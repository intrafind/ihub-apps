// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { EditorSection, FieldError } from '../InstallationEditorParts';
import { HELP_CLASS, LABEL_CLASS, MONO_INPUT_CLASS } from '../../../formStyles';

const K = 'admin.integrations.editors.peopleDirectory.mapping';

/**
 * A preset value (one attribute or a list of them) as the text shown next to
 * a field: the list joined with ", ", empty for none.
 *
 * @param {string|string[]|undefined} value
 * @returns {string}
 */
function presetText(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value ? String(value) : '';
}

/**
 * Section "Search and mapping" of the People directory (LDAP) editor: where
 * people are searched, which entries are people, which attributes free text
 * is matched against, and where each `Person` field is read from.
 *
 * Every value defaults to the effective preset (the directory's own, else the
 * reused sign-in provider's). The preset's value is shown next to each field,
 * and typing an override replaces it for this directory only. A mapping is a
 * comma-separated list of candidates; the first with a value wins. A
 * candidate is an attribute (`mail`), a component of the entry's DN (`dn:l`),
 * or attributes joined with a space (`givenName sn`).
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {Object|undefined} props.preset - The effective preset from the editor context
 * @param {string} props.presetLabel - Its display name
 * @param {string[]} props.fields - The person fields a mapping fills, in display order
 * @param {string} props.baseDnHint - The base DN the search base defaults to
 * @param {Object<string,string>} props.errors - Field errors by install field
 */
function MappingSection({ form, update, preset, presetLabel, fields, baseDnHint, errors }) {
  const { t } = useTranslation();
  const presetMapping = preset?.attributeMapping || {};
  const updateField = (field, text) =>
    update({ attributeMapping: { ...form.attributeMapping, [field]: text } });

  return (
    <EditorSection
      id="pd-mapping"
      title={t(`${K}.title`, 'Search and mapping')}
      description={t(
        `${K}.description`,
        'Defaults come from the directory type "{{preset}}". Leave a field empty to keep the preset value shown next to it.',
        { preset: presetLabel }
      )}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label htmlFor="pd-search-base" className={LABEL_CLASS}>
            {t(`${K}.searchBase`, 'Search base')}
          </label>
          <input
            id="pd-search-base"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={form.searchBase}
            onChange={e => update({ searchBase: e.target.value })}
            placeholder={baseDnHint}
            aria-describedby="pd-search-base-help"
            className={MONO_INPUT_CLASS}
          />
          <p id="pd-search-base-help" className={HELP_CLASS}>
            {t(`${K}.searchBaseHelp`, 'Where people are searched. Defaults to the base DN.')}
          </p>
          <FieldError message={errors.searchBase} />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="pd-person-filter" className={LABEL_CLASS}>
            {t(`${K}.personFilter`, 'Person filter')}
          </label>
          <input
            id="pd-person-filter"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={form.personFilter}
            onChange={e => update({ personFilter: e.target.value })}
            aria-describedby="pd-person-filter-help"
            aria-invalid={errors.personFilter ? 'true' : undefined}
            className={MONO_INPUT_CLASS}
          />
          <p id="pd-person-filter-help" className={HELP_CLASS}>
            {t(`${K}.presetValue`, 'Preset: {{value}}', {
              value: preset?.personFilter || '—'
            })}
          </p>
          <FieldError message={errors.personFilter} />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="pd-search-attributes" className={LABEL_CLASS}>
            {t(`${K}.searchAttributes`, 'Free-text attributes')}
          </label>
          <input
            id="pd-search-attributes"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={form.searchAttributes}
            onChange={e => update({ searchAttributes: e.target.value })}
            aria-describedby="pd-search-attributes-help"
            aria-invalid={errors.searchAttributes ? 'true' : undefined}
            className={MONO_INPUT_CLASS}
          />
          <p id="pd-search-attributes-help" className={HELP_CLASS}>
            {t(`${K}.presetValue`, 'Preset: {{value}}', {
              value: presetText(preset?.searchAttributes) || '—'
            })}{' '}
            {t(
              `${K}.searchAttributesHelp`,
              'Comma-separated, at most 12. Each word of a search is matched against these attributes.'
            )}
          </p>
          <FieldError message={errors.searchAttributes} />
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t(`${K}.fieldsTitle`, 'Person fields')}
        </h4>
        <p id="pd-mapping-help" className={HELP_CLASS}>
          {t(
            `${K}.fieldsHelp`,
            'Comma-separated candidates; the first one with a value wins. A candidate is an attribute (mail), a component of the entry’s DN (dn:l), or attributes joined by a space (givenName sn). Only mapped attributes are read from the directory.'
          )}
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">{t(`${K}.fieldsTitle`, 'Person fields')}</caption>
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-left">
                <th scope="col" className="py-2 pr-3 font-medium text-gray-700 dark:text-gray-300">
                  {t(`${K}.field`, 'Field')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium text-gray-700 dark:text-gray-300">
                  {t(`${K}.presetColumn`, 'Preset')}
                </th>
                <th scope="col" className="py-2 font-medium text-gray-700 dark:text-gray-300">
                  {t(`${K}.overrideColumn`, 'Override')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {fields.map(field => {
                const inputId = `pd-mapping-${field}`;
                const fromPreset = presetText(presetMapping[field]);
                const error = errors[`mapping_${field}`];
                return (
                  <tr key={field}>
                    <td className="py-2 pr-3 align-middle">
                      <label
                        htmlFor={inputId}
                        className="font-medium text-gray-900 dark:text-gray-100"
                      >
                        {t(`admin.integrations.editors.peopleDirectory.fields.${field}`, field)}
                      </label>
                    </td>
                    <td className="py-2 pr-3 align-middle font-mono text-xs text-gray-700 dark:text-gray-300">
                      {fromPreset || (
                        <span className="font-sans text-gray-600 dark:text-gray-400">
                          {t(`${K}.unmapped`, 'not mapped')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 align-middle min-w-[14rem]">
                      <input
                        id={inputId}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={form.attributeMapping?.[field] ?? ''}
                        onChange={e => updateField(field, e.target.value)}
                        aria-describedby="pd-mapping-help"
                        aria-invalid={error ? 'true' : undefined}
                        className={MONO_INPUT_CLASS}
                      />
                      <FieldError message={error} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </EditorSection>
  );
}

export default MappingSection;
