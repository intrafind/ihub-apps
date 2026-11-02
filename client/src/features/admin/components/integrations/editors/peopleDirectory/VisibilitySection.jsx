// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { EditorSection, GrantedGroups } from '../InstallationEditorParts';
import ChoiceField from './ChoiceField';

const K = 'admin.integrations.editors.peopleDirectory.visibility';

/**
 * Section "Visibility" of the People directory (LDAP) editor: who may search
 * this directory, and where the search terms go.
 *
 * Who may use it is decided on the groups (`permissions.integrations`: the
 * installation id, `com.intrafind/ldap-directory`, `type:people-directory` or
 * `*`), not here; the section shows the groups that grant it, with a link to
 * the group page. The grant is ANDed with the app's and the tool grants: an
 * app that binds the directory does not open it to anyone else.
 * `dataFlow: external` marks a third-party directory for the approval policy.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {string[]|null} props.grantedTo - The groups that grant the installation, null while unknown
 */
function VisibilitySection({ form, update, grantedTo }) {
  const { t } = useTranslation();
  return (
    <EditorSection
      id="pd-visibility"
      title={t(`${K}.title`, 'Visibility')}
      description={t(
        `${K}.description`,
        'Who may search this directory, and where the search terms go.'
      )}
    >
      <div>
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t(`${K}.groups`, 'Groups')}
        </h4>
        <GrantedGroups grantedTo={grantedTo} />
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
          {t(
            `${K}.groupsHelp`,
            'A group grants this directory by its id, by "People directory (LDAP)", by "All people directories" or by "*". Apps and tool permissions cannot widen this.'
          )}
        </p>
      </div>

      <fieldset>
        <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t(`${K}.dataFlow`, 'Data flow')}
        </legend>
        <div className="space-y-3">
          <ChoiceField
            id="pd-data-flow-internal"
            name="pd-data-flow"
            value="internal"
            checked={form.dataFlow !== 'external'}
            onChange={() => update({ dataFlow: 'internal' })}
            label={t(`${K}.internal`, 'Internal')}
            help={t(`${K}.internalHelp`, 'The directory is run by your organisation.')}
          />
          <ChoiceField
            id="pd-data-flow-external"
            name="pd-data-flow"
            value="external"
            checked={form.dataFlow === 'external'}
            onChange={() => update({ dataFlow: 'external' })}
            label={t(`${K}.external`, 'External')}
            help={t(
              `${K}.externalHelp`,
              'A third party runs the directory, so the names users search for leave your organisation. Say so in the description, too.'
            )}
          />
        </div>
      </fieldset>
    </EditorSection>
  );
}

export default VisibilitySection;
