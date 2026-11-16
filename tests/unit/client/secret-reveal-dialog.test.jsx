// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * SecretRevealDialog (ID-B15): a rotated OAuth client secret is shown once in
 * a read-only field with Copy, never in window.alert(); closing before the
 * secret was copied warns once.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const SecretRevealDialog =
  require('../../../client/src/shared/components/SecretRevealDialog').default;

const SECRET = 's3cr3t-abcdef-0123456789';

function renderDialog() {
  const onDone = jest.fn();
  const utils = render(
    <SecretRevealDialog
      isOpen
      title='New secret for "Reporting bot"'
      secret={SECRET}
      fieldLabel="Client Secret"
      onDone={onDone}
    />
  );
  return { ...utils, onDone };
}

describe('SecretRevealDialog', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
  });

  it('shows the secret read-only with the one-time notice', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'New secret for "Reporting bot"' })).toBeVisible();
    const field = screen.getByRole('textbox', { name: 'Client Secret' });
    expect(field).toHaveValue(SECRET);
    expect(field).toHaveAttribute('readonly');
    expect(field.className).toMatch(/font-mono/);
    expect(
      screen.getByText('This is the only time the secret is shown. Store it now.')
    ).toBeInTheDocument();
  });

  it('copies the secret and closes on Done', async () => {
    const { onDone } = renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SECRET);
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('warns once when closed without copying, then closes', () => {
    const { onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "You haven't copied the secret yet. Close anyway?"
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close anyway' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Escape follows the same rule', () => {
    const { onDone } = renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('never calls window.alert', () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
