// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SkillsSelector from '../../../../shared/components/SkillsSelector';
import { ALL_SKILLS, assignsAllSkills } from '../../../../../../shared/appWildcards.js';
import { RADIO_CLASS } from '../formStyles';

function CheckboxField({ id, checked, onChange, label, help }) {
  return (
    <div>
      <div className="flex items-center">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded-sm"
        />
        <label htmlFor={id} className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
          {label}
        </label>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{help}</p>
    </div>
  );
}

function SkillsConfigSection({
  enabled,
  allowPersonal,
  selectedSkills,
  onEnabledChange,
  onAllowPersonalChange,
  onSkillsChange
}) {
  const { t } = useTranslation();
  const allSkills = assignsAllSkills(selectedSkills);
  // The skills picked one by one, kept while "All skills" is chosen so that
  // switching back restores them.
  const [picked, setPicked] = useState(() => selectedSkills.filter(name => name !== ALL_SKILLS));

  const chooseAll = all => {
    if (all === allSkills) return;
    if (all) {
      setPicked(selectedSkills);
      onSkillsChange([ALL_SKILLS]);
    } else {
      onSkillsChange(picked);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.skills', 'Skills')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.skillsDesc',
              'Configure which agent skills are available for this app'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-4">
          <CheckboxField
            id="skills-enabled"
            checked={enabled}
            onChange={onEnabledChange}
            label={t('admin.apps.edit.skillsEnabled', 'Enable skills in this app')}
            help={t(
              'admin.apps.edit.skillsEnabledHelp',
              'Skills are opt-in. When off, the app gets no skill list, no skill tools and no active skills, even if users own or are shared skills.'
            )}
          />
          {enabled && (
            <fieldset className="space-y-2">
              <legend className="sr-only">{t('admin.apps.edit.skills', 'Skills')}</legend>
              <div>
                <label className="flex items-start gap-3 cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
                  <input
                    type="radio"
                    name="skills-mode"
                    className={`${RADIO_CLASS} mt-0.5`}
                    checked={allSkills}
                    onChange={() => chooseAll(true)}
                    aria-describedby="skills-all-help"
                  />
                  {t('admin.apps.edit.skillsAll', 'All skills')}
                </label>
                <p id="skills-all-help" className="pl-7 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.apps.edit.skillsAllHelp',
                    "Every skill the user's groups grant, including skills installed later."
                  )}
                </p>
              </div>
              <label className="flex items-start gap-3 cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
                <input
                  type="radio"
                  name="skills-mode"
                  className={`${RADIO_CLASS} mt-0.5`}
                  checked={!allSkills}
                  onChange={() => chooseAll(false)}
                />
                {t('admin.apps.edit.skillsSelected', 'Only selected skills')}
              </label>
            </fieldset>
          )}
          {enabled && !allSkills && (
            <SkillsSelector selectedSkills={selectedSkills} onSkillsChange={onSkillsChange} />
          )}
          {enabled && (
            <CheckboxField
              id="skills-allow-personal"
              checked={allowPersonal}
              onChange={onAllowPersonalChange}
              label={t('admin.apps.edit.skillsAllowPersonal', "Allow users' personal skills")}
              help={t(
                'admin.apps.edit.skillsAllowPersonalHelp',
                "Offer users' own and shared skills in addition to the skills listed above. Turn off to allow only the listed skills."
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default SkillsConfigSection;
