// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin resource picker (group, OAuth client and project editors): the
 * "All (*)" checkbox has an accessible name that says which list it opens up,
 * clicking its text toggles it, and the field label names the search box.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// The picker reads the UI language to show a name that has several languages.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: key => key, i18n: { language: 'en' } })
}));

const ResourceSelector =
  require('../../../client/src/features/admin/components/ResourceSelector').default;

const APPS = [
  { id: 'chat', name: 'Chat' },
  { id: 'translate', name: 'Translate' }
];

test('"All (*)" is named after its field and toggles from its text', () => {
  const onSelectionChange = jest.fn();
  render(
    <>
      <ResourceSelector
        label="Apps"
        resources={APPS}
        selectedResources={[]}
        onSelectionChange={onSelectionChange}
      />
      <ResourceSelector
        label="Models"
        resources={[]}
        selectedResources={[]}
        onSelectionChange={jest.fn()}
      />
    </>
  );

  const appsAll = screen.getByRole('checkbox', { name: 'Apps: All (*)' });
  expect(screen.getByRole('checkbox', { name: 'Models: All (*)' })).toBeInTheDocument();

  fireEvent.click(screen.getAllByText('All (*)')[0]);
  expect(onSelectionChange).toHaveBeenCalledWith(['*']);
  expect(appsAll).toBeInTheDocument();

  expect(screen.getByRole('textbox', { name: 'Apps' })).toBeInTheDocument();
});
