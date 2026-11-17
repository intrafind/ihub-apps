// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Install integration dialog (IN-B12): an untouched form closes on Escape as
 * before; once the admin typed something, Escape, ✕ and Cancel ask "Discard
 * changes?" and a click beside the dialog does nothing.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const DEFINITION = {
  id: 'brave-search',
  name: 'Brave Search',
  version: '1.0.0',
  supported: true,
  protocol: 'rest',
  install: [],
  authModes: ['none'],
  actions: []
};

jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchIntegrationDefinition: jest.fn(async () => DEFINITION),
  fetchInstalledIntegration: jest.fn(),
  installIntegration: jest.fn(),
  updateInstalledIntegration: jest.fn(),
  testIntegrationDraft: jest.fn()
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminGroups: jest.fn(async () => ({ groups: {} })),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/IntegrationTestResults', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const IntegrationInstallDialog =
  require('../../../client/src/features/admin/components/integrations/IntegrationInstallDialog').default;

async function renderDialog() {
  const onClose = jest.fn();
  render(
    <MemoryRouter>
      <IntegrationInstallDialog definitionId="brave-search" onClose={onClose} onSaved={() => {}} />
    </MemoryRouter>
  );
  await screen.findByLabelText('Label');
  return onClose;
}

test('an untouched form closes on Escape without asking', async () => {
  const onClose = await renderDialog();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('after typing, Escape and ✕ ask before discarding; Keep editing keeps the input', async () => {
  const onClose = await renderDialog();
  fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Web search' } });

  fireEvent.keyDown(window, { key: 'Escape' });
  const ask = screen.getByRole('alertdialog', { name: 'Discard changes?' });
  expect(ask).toHaveTextContent('Install integration');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Label')).toHaveValue('Web search');

  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});
