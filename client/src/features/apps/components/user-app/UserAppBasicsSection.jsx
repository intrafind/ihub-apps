// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import IconPicker from '../../../../shared/components/IconPicker';
import AppLanguageField from '../../../admin/components/app-form/AppLanguageField';
import ColorSwatchPicker from '../../../admin/components/app-create/ColorSwatchPicker';
import { LABEL_CLASS } from '../../../admin/components/formStyles';
import { USER_APP_LIMITS } from '../../../../../../shared/userAppContent.js';

/**
 * "Basics" of a personal app: name, short description, icon and colour. The
 * app has no ID to choose, no type and no category, so the basics section of
 * the admin form is not used here.
 *
 * @param {object} props
 * @param {object} props.form - The form state (`userAppForm.js`).
 * @param {(form: object) => void} props.onChange - Receives the changed form state.
 * @returns {JSX.Element}
 */
function UserAppBasicsSection({ form, onChange }) {
  const { t } = useTranslation();
  const iconLabelId = useId();
  const set = (key, value) => onChange({ ...form, [key]: value });
  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6 space-y-6">
      <AppLanguageField
        label={t('admin.apps.create.essentials.name')}
        help={t('admin.apps.create.essentials.nameHelp')}
        value={form.name}
        onChange={value => set('name', value)}
        required
        maxLength={USER_APP_LIMITS.name}
        name="name"
      />
      <AppLanguageField
        label={t('admin.apps.create.essentials.description')}
        help={t('admin.apps.create.essentials.descriptionHelp')}
        value={form.description}
        onChange={value => set('description', value)}
        required
        maxLength={USER_APP_LIMITS.description}
        name="description"
      />
      <div className="flex flex-wrap items-start gap-6">
        <div>
          <span id={iconLabelId} className={LABEL_CLASS}>
            {t('admin.apps.create.essentials.icon')}
          </span>
          <IconPicker
            labelledBy={iconLabelId}
            value={form.icon}
            onChange={icon => set('icon', icon)}
          />
        </div>
        <ColorSwatchPicker
          label={t('admin.apps.create.essentials.color')}
          value={form.color}
          onChange={color => set('color', color)}
        />
      </div>
    </div>
  );
}

export default UserAppBasicsSection;
