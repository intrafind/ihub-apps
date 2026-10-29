// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import GroupMultiSelect from '../GroupMultiSelect';
import FormSection from './FormSection';
import ChoiceField from './ChoiceField';
import { CALLOUT_CLASS } from './formStyles';

/**
 * Editor section "Visibility": who may use the directory, and whether search
 * terms leave the organisation.
 *
 * `groups` is ANDed with the other grants: an app that lists the directory's
 * tools, or a `tools: ["*"]` permission, does not open it to anyone outside
 * these groups. `dataFlow: external` marks a third-party directory for the
 * approval policy.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {Array<{id: string, name?: string, description?: string}>} props.availableGroups - Defined groups
 */
function VisibilitySection({ form, update, availableGroups }) {
  const { t } = useTranslation();
  const groupOptions = [
    {
      id: '*',
      name: t('admin.peopleDirectories.visibility.everyone', 'Everyone (*)'),
      description: t(
        'admin.peopleDirectories.visibility.everyoneHelp',
        'Every user, anonymous users included'
      )
    },
    ...availableGroups
  ];

  return (
    <FormSection
      id="pd-visibility"
      title={t('admin.peopleDirectories.visibility.title', 'Visibility')}
      description={t(
        'admin.peopleDirectories.visibility.description',
        'Who may search this directory, and where the search terms go.'
      )}
    >
      <GroupMultiSelect
        id="pd-groups"
        label={t('admin.peopleDirectories.visibility.groups', 'Groups')}
        value={form.groups}
        onChange={groups => update({ groups })}
        availableGroups={groupOptions}
        allowCustom={false}
        placeholder={t('admin.peopleDirectories.visibility.groupsPlaceholder', 'Search groups…')}
        helpText={t(
          'admin.peopleDirectories.visibility.groupsHelp',
          'Users need one of these groups in addition to access to the app or tool. Apps and tool permissions cannot widen this list.'
        )}
      />
      {form.groups.length === 0 && (
        <div className={CALLOUT_CLASS.warning} role="note">
          {t(
            'admin.peopleDirectories.visibility.noGroups',
            'No group selected: nobody can use this directory.'
          )}
        </div>
      )}

      <fieldset>
        <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('admin.peopleDirectories.visibility.dataFlow', 'Data flow')}
        </legend>
        <div className="space-y-3">
          <ChoiceField
            id="pd-data-flow-internal"
            name="pd-data-flow"
            value="internal"
            checked={form.dataFlow !== 'external'}
            onChange={() => update({ dataFlow: 'internal' })}
            label={t('admin.peopleDirectories.visibility.internal', 'Internal')}
            help={t(
              'admin.peopleDirectories.visibility.internalHelp',
              'The directory is run by your organisation.'
            )}
          />
          <ChoiceField
            id="pd-data-flow-external"
            name="pd-data-flow"
            value="external"
            checked={form.dataFlow === 'external'}
            onChange={() => update({ dataFlow: 'external' })}
            label={t('admin.peopleDirectories.visibility.external', 'External')}
            help={t(
              'admin.peopleDirectories.visibility.externalHelp',
              'A third party runs the directory, so the names users search for leave your organisation. Say so in the description, too.'
            )}
          />
        </div>
      </fieldset>
    </FormSection>
  );
}

export default VisibilitySection;
