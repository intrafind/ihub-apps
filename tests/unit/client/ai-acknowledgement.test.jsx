// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

let mockUiConfig = {};
const mockFetch = jest.fn();
const mockAcknowledge = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en', resolvedLanguage: 'en', t: (key, fallback) => fallback || key }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({ name }) => (
  <span data-testid={`icon-${name}`} />
));
jest.mock('../../../client/src/api', () => ({
  fetchMyAiAcknowledgement: (...args) => mockFetch(...args),
  acknowledgeAi: (...args) => mockAcknowledge(...args)
}));
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  useOptionalAuth: () => ({ isLoading: false, isAuthenticated: true, user: { id: 'alice' } })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: mockUiConfig })
}));

import { AiAcknowledgementProvider } from '../../../client/src/shared/contexts/AiAcknowledgementContext';
import { useAiAcknowledgement } from '../../../client/src/shared/hooks/useAiAcknowledgement';

const notice = (extra = {}) => ({
  enabled: true,
  enforce: true,
  acknowledged: false,
  requiredVersion: 2,
  text: 'Use AI responsibly.',
  textHash: 'sha256:abc',
  language: 'en',
  policyUrl: 'https://example.com/policy',
  ...extra
});

let lastResult;
function Sender() {
  const ack = useAiAcknowledgement();
  return (
    <>
      <button
        onClick={async () =>
          (lastResult = await ack.ensureAcknowledged({ hasPendingMessage: true }))
        }
      >
        send
      </button>
      <button onClick={async () => (lastResult = await ack.handleAcknowledgementRequired())}>
        refused
      </button>
    </>
  );
}

const setup = async () => {
  render(
    <AiAcknowledgementProvider>
      <Sender />
    </AiAcknowledgementProvider>
  );
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => {});
};

beforeEach(() => {
  mockUiConfig = {};
  lastResult = undefined;
  mockFetch.mockReset();
  mockAcknowledge.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('AiAcknowledgementProvider', () => {
  it('does not gate while the feature is off or already acknowledged', async () => {
    mockFetch.mockResolvedValue({ enabled: false, enforce: false, acknowledged: true });
    await setup();
    await userEvent.click(screen.getByText('send'));
    expect(lastResult).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the dialog when enabled and not acknowledged, and Confirm posts the shown version and hash', async () => {
    mockFetch.mockResolvedValue(notice());
    mockAcknowledge.mockResolvedValue({});
    await setup();
    await userEvent.click(screen.getByText('send'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Use AI responsibly.');
    expect(screen.getByText('Confirm and send')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Confirm and send'));
    await waitFor(() => expect(lastResult).toBe(true));
    expect(mockAcknowledge).toHaveBeenCalledWith({
      version: 2,
      textHash: 'sha256:abc',
      language: 'en'
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel resolves false and keeps the user blocked', async () => {
    mockFetch.mockResolvedValue(notice());
    await setup();
    await userEvent.click(screen.getByText('send'));
    await userEvent.click(await screen.findByText('Cancel'));
    await waitFor(() => expect(lastResult).toBe(false));
    expect(mockAcknowledge).not.toHaveBeenCalled();
  });

  it('renders the text as text: markup stays inert', async () => {
    mockFetch.mockResolvedValue(notice({ text: '<img src=x onerror="window.__xss=1"> hi' }));
    await setup();
    await userEvent.click(screen.getByText('send'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog).toHaveTextContent('<img src=x onerror="window.__xss=1"> hi');
    expect(window.__xss).toBeUndefined();
  });

  it('shows the policy link in a new tab with noopener', async () => {
    mockFetch.mockResolvedValue(notice());
    await setup();
    await userEvent.click(screen.getByText('send'));
    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/policy');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('a 428 re-opens the gate even if this tab believed it was acknowledged', async () => {
    mockFetch
      .mockResolvedValueOnce(notice({ acknowledged: true }))
      .mockResolvedValueOnce(notice({ acknowledged: false, requiredVersion: 3 }));
    mockAcknowledge.mockResolvedValue({});
    await setup();
    await userEvent.click(screen.getByText('refused'));
    await userEvent.click(await screen.findByText('Confirm and send'));
    await waitFor(() => expect(lastResult).toBe(true));
    expect(mockAcknowledge).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
  });

  it('a 409 refetches the notice and asks again with a stale hint', async () => {
    mockFetch
      .mockResolvedValueOnce(notice())
      .mockResolvedValueOnce(notice({ text: 'New text', textHash: 'sha256:new' }));
    mockAcknowledge.mockRejectedValueOnce({ status: 409, code: 'CONFLICT' });
    await setup();
    await userEvent.click(screen.getByText('send'));
    await userEvent.click(await screen.findByText('Confirm and send'));
    expect(await screen.findByText(/The notice was updated/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('New text');
  });

  it('a save failure keeps the dialog open with an alert and Try again', async () => {
    mockFetch.mockResolvedValue(notice());
    mockAcknowledge.mockRejectedValueOnce(new Error('boom'));
    await setup();
    await userEvent.click(screen.getByText('send'));
    await userEvent.click(await screen.findByText('Confirm and send'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(lastResult).toBeUndefined();
  });

  it('queues behind the disclaimer popup and never stacks with it', async () => {
    mockUiConfig = { disclaimer: { enabled: true, text: { en: 'x' } } };
    mockFetch.mockResolvedValue(notice());
    await setup();
    await userEvent.click(screen.getByText('send'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('ihub-disclaimer-closed'));
    });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('ask-only mode: the dialog can be skipped once per browser session', async () => {
    mockFetch.mockResolvedValue(notice({ enforce: false }));
    await setup();
    await userEvent.click(screen.getByText('send'));
    await userEvent.click(await screen.findByText('Continue without confirming'));
    await waitFor(() => expect(lastResult).toBe(true));
    expect(mockAcknowledge).not.toHaveBeenCalled();
    lastResult = undefined;
    await userEvent.click(screen.getByText('send'));
    expect(lastResult).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
