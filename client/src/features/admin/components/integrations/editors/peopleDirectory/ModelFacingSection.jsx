// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../../../../shared/components/DynamicLanguageEditor';
import { EditorSection } from '../InstallationEditorParts';
import { CALLOUT_CLASS } from '../../../formStyles';
import { FORM_LANGUAGES, toolIdsFor } from '../peopleDirectoryEditorModel';

const K = 'admin.integrations.editors.peopleDirectory.model';

/**
 * Section "Model-facing name and description" of the People directory (LDAP)
 * editor: the installation's label and description, which the model reads to
 * decide which directory fits a question. They become the name and
 * description of the directory's tools, so the section previews them the way
 * the model sees them, in English and German, with the tool ids apps select.
 *
 * Unlike the other editors' name section, every language is edited at once:
 * the model reads the user's language.
 *
 * @param {Object} props
 * @param {string} props.instanceId - The installation id (the tool id prefix)
 * @param {Object} props.form - Form state (`name`, `description`, `units`)
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 */
function ModelFacingSection({ instanceId, form, update }) {
  const { t } = useTranslation();
  const toolIds = toolIdsFor(instanceId, form.units);

  return (
    <EditorSection
      id="pd-model"
      title={t(`${K}.title`, 'Model-facing name and description')}
      description={t(
        `${K}.description`,
        'The model chooses a directory by these texts. Say whose staff it lists, which fields it has, and whether it is an external service.'
      )}
    >
      <DynamicLanguageEditor
        label={t(`${K}.name`, 'Name')}
        name="pd-name"
        value={form.name}
        onChange={name => update({ name })}
        placeholder={{ en: 'Company directory', de: 'Firmenverzeichnis' }}
      />
      <DynamicLanguageEditor
        label={t(`${K}.descriptionLabel`, 'Description')}
        name="pd-description"
        type="textarea"
        value={form.description}
        onChange={description => update({ description })}
        placeholder={{
          en: 'Employees of our company: name, e-mail, phone, department, manager.',
          de: 'Mitarbeitende unseres Unternehmens: Name, E-Mail, Telefon, Abteilung, Vorgesetzte.'
        }}
      />

      <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t(`${K}.previewTitle`, 'What the model sees')}
        </h4>
        <dl className="mt-2 space-y-2">
          {FORM_LANGUAGES.map(lang => {
            const name = form.name?.[lang]?.trim() || form.name?.en?.trim() || instanceId || '—';
            const description =
              form.description?.[lang]?.trim() || form.description?.en?.trim() || '';
            return (
              <div key={lang} className="flex gap-2 text-sm">
                <dt className="w-8 shrink-0 font-medium uppercase text-gray-600 dark:text-gray-400">
                  {lang}
                </dt>
                <dd lang={lang} className="text-gray-900 dark:text-gray-100">
                  <span className="font-medium">{name}</span>
                  {description ? ` – ${description}` : ''}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-3 text-xs text-gray-600 dark:text-gray-400" data-testid="pd-tool-ids">
          {t(`${K}.toolIds`, 'Tools apps can bind:')}{' '}
          {toolIds.map((toolId, index) => (
            <span key={toolId}>
              {index > 0 && ', '}
              <code className="font-mono text-gray-800 dark:text-gray-200">{toolId}</code>
            </span>
          ))}
        </p>
      </div>

      {!FORM_LANGUAGES.some(lang => form.description?.[lang]?.trim()) && (
        <div className={CALLOUT_CLASS.info} role="note">
          {t(
            `${K}.noDescription`,
            'Without a description the model knows nothing but the name and id, and may pick the wrong directory.'
          )}
        </div>
      )}
    </EditorSection>
  );
}

export default ModelFacingSection;
