// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The test panel of the app editor (#2510, `AppTestPanel`): the saved app's
 * chat beside the editor. Beside it on wide screens; below `lg` it covers the
 * editor, and is a dialog there — focus moves in, Escape closes, and focus goes
 * back to the Test button (WCAG 2.4.3).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApi = { fetchAppDetails: jest.fn() };
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAppDetails: (...args) => mockApi.fetchAppDetails(...args)
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildPath: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));
jest.mock('../../../client/src/features/apps/pages/AppChat', () => ({
  __esModule: true,
  default: () => <div data-testid="app-chat" />
}));

const AppTestPanel = require('../../../client/src/features/admin/components/AppTestPanel').default;

const original = window.matchMedia;

beforeEach(() => {
  mockApi.fetchAppDetails.mockReset();
  mockApi.fetchAppDetails.mockResolvedValue({ id: 'support', type: 'chat' });
});

afterEach(() => {
  window.matchMedia = original;
});

function openedFrom() {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  return opener;
}

function renderPanel(props = {}) {
  const onClose = jest.fn();
  const utils = render(
    <AppTestPanel
      appId="support"
      enabled
      isDirty={false}
      reloadKey={0}
      onClose={onClose}
      {...props}
    />
  );
  return { onClose, ...utils };
}

describe('AppTestPanel covering the editor (below lg)', () => {
  // jsdom has no matchMedia, which the hook reads as "below lg".
  test('is a dialog: focus moves in, Escape closes, focus goes back to the opener', async () => {
    const opener = openedFrom();
    const { onClose, unmount } = renderPanel();
    await screen.findByTestId('app-chat');

    const panel = screen.getByRole('dialog', { name: 'Test app' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close test panel' })).toHaveFocus();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  test('is a dialog for a disabled app too, which has only the close button to reach', async () => {
    const opener = openedFrom();
    const { onClose } = renderPanel({ enabled: false });

    const panel = screen.getByRole('dialog', { name: 'Test app' });
    expect(screen.getByRole('button', { name: 'Close test panel' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Restart with a new chat' })).toBeNull();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    opener.remove();
  });

  test('still closes with the button', async () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Close test panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AppTestPanel beside the editor (from lg up)', () => {
  beforeEach(() => {
    window.matchMedia = () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {}
    });
  });

  test('is a plain side panel: no dialog, no focus taken, Escape left alone', async () => {
    const opener = openedFrom();
    const { onClose } = renderPanel();
    await screen.findByTestId('app-chat');

    const panel = screen.getByLabelText('Test app');
    expect(panel).not.toHaveAttribute('role');
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    opener.remove();
  });
});
