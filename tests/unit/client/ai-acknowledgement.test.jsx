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

const mockOpenExternalUrl = jest.fn();
jest.mock('../../../client/src/utils/externalNavigation', () => ({
  openExternalUrl: (...args) => mockOpenExternalUrl(...args)
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

const setup = async (props = {}) => {
  render(
    <AiAcknowledgementProvider {...props}>
      <Sender />
    </AiAcknowledgementProvider>
  );
  if (props.active !== false) await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => {});
};

beforeEach(() => {
  mockUiConfig = {};
  lastResult = undefined;
  mockFetch.mockReset();
  mockAcknowledge.mockReset();
  mockOpenExternalUrl.mockReset();
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

  it('Confirm while the EU AI Act features get switched off: no error, the dialog closes and the message goes on', async () => {
    // The notice is read on mount and again at the click; the reload after the 403 says "off".
    mockFetch
      .mockResolvedValueOnce(notice())
      .mockResolvedValueOnce(notice())
      .mockResolvedValue({ enabled: false, enforce: false, acknowledged: true });
    mockAcknowledge.mockRejectedValue({
      response: { status: 403, data: { code: 'FEATURE_DISABLED' } }
    });
    await setup();
    await userEvent.click(screen.getByText('send'));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByText('Confirm and send'));
    await waitFor(() => expect(lastResult).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
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
      // The re-check before the dialog opens.
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

describe('AiAcknowledgementProvider in an embedded host (Outlook pane, extension)', () => {
  it('makes no request while inactive, and gates nothing', async () => {
    await setup({ active: false });
    await userEvent.click(screen.getByText('send'));
    expect(lastResult).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reads the state when it becomes active and again when the viewer changes', async () => {
    mockFetch.mockResolvedValue(notice({ acknowledged: true }));
    const view = render(
      <AiAcknowledgementProvider active={false} viewerKey="">
        <Sender />
      </AiAcknowledgementProvider>
    );
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
    view.rerender(
      <AiAcknowledgementProvider active viewerKey="office:alice">
        <Sender />
      </AiAcknowledgementProvider>
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    view.rerender(
      <AiAcknowledgementProvider active viewerKey="office:bob">
        <Sender />
      </AiAcknowledgementProvider>
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it('does not print the guest line to a signed-in viewer without an AuthProvider', async () => {
    mockFetch.mockResolvedValue(notice());
    await setup({ anonymous: false, viewerKey: 'office:alice' });
    await userEvent.click(screen.getByText('send'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent('applies to this browser session only');
  });

  it('asks the server again before opening: confirmed in another client, no dialog', async () => {
    mockFetch.mockResolvedValueOnce(notice()).mockResolvedValueOnce(notice({ acknowledged: true }));
    await setup();
    await userEvent.click(screen.getByText('send'));
    await waitFor(() => expect(lastResult).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('tells the sender the user is asked (onAsk), not when nothing is asked', async () => {
    mockFetch.mockResolvedValue(notice());
    const onAsk = jest.fn();
    function Asker() {
      const ack = useAiAcknowledgement();
      return (
        <button onClick={() => ack.ensureAcknowledged({ hasPendingMessage: true, onAsk })}>
          ask
        </button>
      );
    }
    render(
      <AiAcknowledgementProvider>
        <Asker />
      </AiAcknowledgementProvider>
    );
    await act(async () => {});
    await userEvent.click(screen.getByText('ask'));
    await screen.findByRole('dialog');
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it('focus on the pane picks up a confirmation made elsewhere and closes the dialog', async () => {
    mockFetch
      .mockResolvedValueOnce(notice())
      .mockResolvedValueOnce(notice())
      .mockResolvedValue(notice({ acknowledged: true }));
    await setup();
    await userEvent.click(screen.getByText('send'));
    await screen.findByRole('dialog');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(lastResult).toBe(true);
  });

  it('a notice that cannot be loaded opens a "could not load" state with Try again, never a hang', async () => {
    mockFetch.mockRejectedValue(new Error('x'));
    await setup();
    await userEvent.click(screen.getByText('refused'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('The notice could not be loaded');
    // Retry succeeds and the user was confirmed elsewhere: the dialog closes, the send goes on.
    mockFetch.mockResolvedValue(notice({ acknowledged: true }));
    await userEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(lastResult).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel on the "could not load" state resolves false', async () => {
    mockFetch.mockRejectedValue(new Error('x'));
    await setup();
    await userEvent.click(screen.getByText('refused'));
    await userEvent.click(await screen.findByText('Cancel'));
    await waitFor(() => expect(lastResult).toBe(false));
  });

  it('a guest whose confirmation does not stick (cookie dropped) is told to open iHub in its own tab', async () => {
    mockFetch
      .mockResolvedValueOnce(notice({ appUrl: 'https://ihub.example/ihub' }))
      .mockResolvedValueOnce(notice({ appUrl: 'https://ihub.example/ihub' }))
      // After the POST the server still does not know the guest.
      .mockResolvedValue(notice({ appUrl: 'https://ihub.example/ihub' }));
    mockAcknowledge.mockResolvedValue({});
    await setup({ anonymous: true });
    await userEvent.click(screen.getByText('send'));
    await userEvent.click(await screen.findByText('Confirm and send'));
    expect(await screen.findByRole('alert')).toHaveTextContent('blocks cookies in this frame');
    expect(lastResult).toBeUndefined();
    await userEvent.click(screen.getByText('Open iHub in the browser'));
    expect(mockOpenExternalUrl).toHaveBeenCalledWith('https://ihub.example/ihub');
  });

  it('a guest whose cookie works is confirmed as before', async () => {
    mockFetch
      .mockResolvedValueOnce(notice())
      .mockResolvedValueOnce(notice())
      .mockResolvedValue(notice({ acknowledged: true }));
    mockAcknowledge.mockResolvedValue({});
    await setup({ anonymous: true });
    await userEvent.click(screen.getByText('send'));
    await userEvent.click(await screen.findByText('Confirm and send'));
    await waitFor(() => expect(lastResult).toBe(true));
  });

  it('review after confirming shows the notice read-only with one Close, and no composer note', async () => {
    mockFetch.mockResolvedValue(notice({ acknowledged: true }));
    function Reviewer() {
      const ack = useAiAcknowledgement();
      return (
        <>
          <button onClick={() => ack.review()}>review</button>
          <span data-testid="pending">{String(ack.pending)}</span>
          <span data-testid="declined">{String(ack.declined)}</span>
          <span data-testid="available">{String(ack.available)}</span>
        </>
      );
    }
    render(
      <AiAcknowledgementProvider>
        <Reviewer />
      </AiAcknowledgementProvider>
    );
    await act(async () => {});
    expect(screen.getByTestId('available')).toHaveTextContent('true');
    await userEvent.click(screen.getByText('review'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Use AI responsibly.');
    expect(screen.queryByText('Cancel')).toBeNull();
    expect(screen.queryByText('Confirm and send')).toBeNull();
    // The pane regaining focus must not close the notice the user is reading.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('declined')).toHaveTextContent('false');
  });
});

describe('AiAcknowledgementDialog policy link in a host', () => {
  it('uses the host opener, keeps the dialog open and shows nothing extra when it worked', async () => {
    mockFetch.mockResolvedValue(notice());
    const openPolicy = jest.fn().mockResolvedValue(true);
    await setup({ openPolicy });
    await userEvent.click(screen.getByText('send'));
    await userEvent.click(await screen.findByRole('link'));
    expect(openPolicy).toHaveBeenCalledWith('https://example.com/policy');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-ack-policy-address')).toBeNull();
  });

  it('shows the address to copy when the host could not open it', async () => {
    mockFetch.mockResolvedValue(notice());
    const openPolicy = jest.fn().mockResolvedValue(false);
    await setup({ openPolicy });
    await userEvent.click(screen.getByText('send'));
    await userEvent.click(await screen.findByRole('link'));
    const box = await screen.findByTestId('ai-ack-policy-address');
    expect(box).toHaveTextContent('https://example.com/policy');
    expect(box).toHaveTextContent('could not be opened');
    expect(screen.getByText('Copy address')).toBeInTheDocument();
  });

  it('always shows the address when the host cannot confirm the open (pop-out)', async () => {
    mockFetch.mockResolvedValue(notice());
    await setup({ openPolicy: jest.fn().mockResolvedValue(true), showPolicyAddress: true });
    await userEvent.click(screen.getByText('send'));
    expect(await screen.findByTestId('ai-ack-policy-address')).toHaveTextContent(
      'https://example.com/policy'
    );
  });

  it('never links a non-http policy address', async () => {
    mockFetch.mockResolvedValue(notice({ policyUrl: 'javascript:alert(1)' }));
    await setup();
    await userEvent.click(screen.getByText('send'));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('without a host opener the anchor keeps its own target=_blank behaviour', async () => {
    mockFetch.mockResolvedValue(notice());
    await setup();
    await userEvent.click(screen.getByText('send'));
    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.queryByTestId('ai-ack-policy-address')).toBeNull();
  });
});
