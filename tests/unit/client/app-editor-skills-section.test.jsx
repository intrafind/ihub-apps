// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * App editor → Skills: "All skills" writes `"*"` and keeps the skills picked
 * one by one next to it (`skillSettings.autoActivate` still runs those);
 * "Only selected skills" drops `"*"` and shows the picker again.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/SkillsSelector', () => ({
  __esModule: true,
  default: () => <input placeholder="Search skills to add..." />
}));

import SkillsConfigSection from '../../../client/src/features/admin/components/app-form/SkillsConfigSection';

function renderSection(selectedSkills) {
  const onSkillsChange = jest.fn();
  render(
    <SkillsConfigSection
      enabled
      allowPersonal
      selectedSkills={selectedSkills}
      onEnabledChange={jest.fn()}
      onAllowPersonalChange={jest.fn()}
      onSkillsChange={onSkillsChange}
    />
  );
  return onSkillsChange;
}

describe('SkillsConfigSection', () => {
  it('"All skills" keeps the named skills next to "*"', () => {
    const onSkillsChange = renderSection(['skill-builder']);
    fireEvent.click(screen.getByRole('radio', { name: 'All skills' }));
    expect(onSkillsChange).toHaveBeenCalledWith(['*', 'skill-builder']);
  });

  it('"Only selected skills" drops "*" and shows the picker', () => {
    const onSkillsChange = renderSection(['*', 'skill-builder']);
    expect(screen.queryByPlaceholderText('Search skills to add...')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Only selected skills' }));
    expect(onSkillsChange).toHaveBeenCalledWith(['skill-builder']);
  });
});
