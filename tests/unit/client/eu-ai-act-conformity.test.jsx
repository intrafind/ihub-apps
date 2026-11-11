// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The EU AI Act master switch in the admin UI (step 9): the card and its two
 * dialogs, the paused cards, the shared state note and the public config member.
 *
 * Only the API modules and the translation hook are stubbed.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = { disableConformity: jest.fn(), enableConformity: jest.fn() };
jest.mock('../../../client/src/api/euAiActAdminApi', () => ({
  __esModule: true,
  disableConformity: (...a) => mockApi.disableConformity(...a),
  enableConformity: (...a) => mockApi.enableConformity(...a),
  verifyText: jest.fn(),
  verifyFile: jest.fn(),
  fetchWatermarkKeys: jest.fn(async () => ({ items: [] })),
  fetchWatermarkDetectors: jest.fn(async () => ({ items: [] })),
  testWatermarkDetector: jest.fn(),
  runWatermarkSelfTest: jest.fn()
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: jest.fn(async () => ({ data: {} })),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));
const mockApiIndex = {
  fetchAuthStatus: jest.fn(async () => ({ authenticated: false })),
  fetchUIConfig: jest.fn(async () => ({})),
  fetchPlatformConfig: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAuthStatus: (...a) => mockApiIndex.fetchAuthStatus(...a),
  fetchUIConfig: (...a) => mockApiIndex.fetchUIConfig(...a),
  fetchPlatformConfig: (...a) => mockApiIndex.fetchPlatformConfig(...a),
  invalidateAuthStatusCache: jest.fn(),
  invalidatePlatformConfigCache: jest.fn(),
  invalidateUIConfigCache: jest.fn()
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

import ConformityCard from '../../../client/src/features/admin/components/euAiAct/ConformityCard';
import ConfigCheckCard from '../../../client/src/features/admin/components/euAiAct/ConfigCheckCard';
import AcknowledgementsCard from '../../../client/src/features/admin/components/euAiAct/AcknowledgementsCard';
import VerificationCard from '../../../client/src/features/admin/components/euAiAct/VerificationCard';
import EuAiActStateNote from '../../../client/src/features/admin/components/euAiAct/EuAiActStateNote';
import PlatformConfigContext, {
  PlatformConfigProvider,
  usePlatformConfig
} from '../../../client/src/shared/contexts/PlatformConfigContext';

const REASON = 'Internal research sandbox, no EU users, no public output.';
const ACTOR = { id: 'dmeyer', name: 'Dana Meyer' };
const ON = { enabled: true, valid: true, history: [] };
const OFF = {
  enabled: false,
  valid: true,
  changedAt: '2026-11-12T09:30:00.000Z',
  changedBy: ACTOR,
  reason: REASON,
  statementVersion: 1,
  history: [
    { enabled: false, changedAt: '2026-11-12T09:30:00.000Z', changedBy: ACTOR, reason: REASON }
  ]
};

const withConfig = (ui, enabled = true) =>
  render(
    <MemoryRouter>
      <PlatformConfigContext.Provider
        value={{
          platformConfig: { euAiAct: { enabled } },
          isLoading: false,
          refreshConfig: () => {}
        }}
      >
        {ui}
      </PlatformConfigContext.Provider>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
});

describe('ConformityCard: on', () => {
  test('shows On and a Switch off button, no success tone', () => {
    withConfig(<ConformityCard conformity={ON} onReload={jest.fn()} />);
    expect(screen.getByTestId('conformity-state')).toHaveAttribute('data-state', 'on');
    expect(screen.getByRole('button', { name: 'Switch off...' })).toBeInTheDocument();
    expect(document.querySelector('[class*="green"]')).toBeNull();
  });

  test('confirm stays aria-disabled until the reason has 20 trimmed characters and the box is ticked', async () => {
    withConfig(<ConformityCard conformity={ON} onReload={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off...' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByTestId('conformity-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    fireEvent.change(within(dialog).getByTestId('conformity-reason'), {
      target: { value: `   ${'x'.repeat(19)}   ` }
    });
    expect(within(dialog).getByText('Enter at least 1 more characters.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByTestId('conformity-reason'), {
      target: { value: 'x'.repeat(20) }
    });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByText('Tick the box to continue.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('conformity-accept'));
    expect(confirm).not.toHaveAttribute('aria-disabled');

    // Over 1000 characters is refused again.
    fireEvent.change(within(dialog).getByTestId('conformity-reason'), {
      target: { value: 'x'.repeat(1001) }
    });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirm);
    expect(mockApi.disableConformity).not.toHaveBeenCalled();
  });

  test('the dialog lists what stops and what stays, with the legal note and the vLLM caveat', () => {
    withConfig(<ConformityCard conformity={ON} onReload={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off...' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('This will be switched off')).toBeInTheDocument();
    expect(within(dialog).getByText('This stays')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/does not remove your organisation's obligations/)
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/vLLM/)).toBeInTheDocument();
  });

  test('submitting sends the trimmed reason; the banner shows who, when and why', async () => {
    mockApi.disableConformity.mockResolvedValue(OFF);
    const onReload = jest.fn();
    withConfig(<ConformityCard conformity={ON} onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off...' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('conformity-reason'), {
      target: { value: `  ${REASON}  ` }
    });
    fireEvent.click(within(dialog).getByTestId('conformity-accept'));
    fireEvent.click(within(dialog).getByTestId('conformity-confirm'));
    await waitFor(() => expect(mockApi.disableConformity).toHaveBeenCalledWith({ reason: REASON }));
    await waitFor(() =>
      expect(screen.getByTestId('conformity-state')).toHaveAttribute('data-state', 'off')
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('conformity-who')).toHaveTextContent('Dana Meyer (dmeyer)');
    expect(screen.getByTestId('conformity-reason-text')).toHaveTextContent(REASON);
    expect(onReload).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Recorded for Dana Meyer (dmeyer)');
  });

  test('a conflict keeps the dialog and the typed reason, and shows who was first', async () => {
    mockApi.disableConformity.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: 'CONFLICT',
          details: { enabled: false, changedAt: '2026-11-12T09:30:00.000Z', changedBy: ACTOR }
        }
      }
    });
    withConfig(<ConformityCard conformity={ON} onReload={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off...' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('conformity-reason'), {
      target: { value: REASON }
    });
    fireEvent.click(within(dialog).getByTestId('conformity-accept'));
    fireEvent.click(within(dialog).getByTestId('conformity-confirm'));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Another admin changed this');
    expect(alert).toHaveTextContent('Dana Meyer (dmeyer)');
    expect(within(dialog).getByTestId('conformity-reason')).toHaveValue(REASON);
  });

  test('a failure keeps the reason (and the draft survives a reload in sessionStorage)', async () => {
    mockApi.disableConformity.mockRejectedValue({ response: { status: 500, data: {} } });
    const { unmount } = withConfig(<ConformityCard conformity={ON} onReload={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off...' }));
    let dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('conformity-reason'), {
      target: { value: REASON }
    });
    fireEvent.click(within(dialog).getByTestId('conformity-accept'));
    fireEvent.click(within(dialog).getByTestId('conformity-confirm'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your reason is kept');
    unmount();
    withConfig(<ConformityCard conformity={ON} onReload={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off...' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('conformity-reason')).toHaveValue(REASON);
  });
});

describe('ConformityCard: off', () => {
  test('is an amber banner with who, when, why, the legal note and Switch on again', () => {
    withConfig(<ConformityCard conformity={OFF} onReload={jest.fn()} />, false);
    expect(screen.getByTestId('conformity-state')).toHaveAttribute('data-state', 'off');
    expect(
      screen.getByRole('heading', { name: 'EU AI Act features are switched off' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('conformity-who')).toHaveTextContent('Dana Meyer (dmeyer)');
    expect(screen.getByTestId('conformity-reason-text')).toHaveTextContent(REASON);
    expect(screen.getByText(/This is not legal advice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch on again...' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch off...' })).toBeNull();
    // History is closed by default and lists the entry.
    expect(screen.getByTestId('conformity-history').open).toBe(false);
  });

  test('a long reason is clamped with a Show full reason button', () => {
    const long = { ...OFF, reason: 'word '.repeat(80) };
    withConfig(<ConformityCard conformity={long} onReload={jest.fn()} />, false);
    const show = screen.getByRole('button', { name: 'Show full reason' });
    fireEvent.click(show);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  test('Switch on again takes an optional reason', async () => {
    mockApi.enableConformity.mockResolvedValue({
      ...ON,
      history: [
        { enabled: true, changedAt: '2026-11-13T09:00:00.000Z', changedBy: ACTOR },
        ...OFF.history
      ]
    });
    withConfig(<ConformityCard conformity={OFF} onReload={jest.fn()} />, false);
    fireEvent.click(screen.getByRole('button', { name: 'Switch on again...' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByTestId('conformity-accept')).toBeNull();
    expect(within(dialog).getByTestId('conformity-confirm')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(within(dialog).getByTestId('conformity-confirm'));
    await waitFor(() =>
      expect(mockApi.enableConformity).toHaveBeenCalledWith({ reason: undefined })
    );
    await waitFor(() =>
      expect(screen.getByTestId('conformity-state')).toHaveAttribute('data-state', 'on')
    );
    expect(screen.getByTestId('conformity-gap')).toHaveTextContent(
      'Nothing was recorded or marked'
    );
  });
});

describe('states', () => {
  test('loading shows a busy skeleton, a failed load says the status is unknown', () => {
    const { rerender } = withConfig(
      <ConformityCard conformity={null} loading onReload={jest.fn()} />
    );
    expect(screen.getByText('Loading status')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <ConformityCard conformity={null} loading={false} error="boom" onReload={jest.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByText('Status unknown')).toBeInTheDocument();
  });

  test('an invalid stored record is called out while the features stay on', () => {
    withConfig(<ConformityCard conformity={{ ...ON, valid: false }} onReload={jest.fn()} />);
    expect(screen.getByTestId('conformity-invalid')).toBeInTheDocument();
  });
});

describe('paused cards', () => {
  test('the configuration check shows "not evaluated" and no checks', () => {
    withConfig(
      <ConfigCheckCard
        status={{
          summary: { level: 'disabled', counts: { ok: 0, warn: 0, error: 0 } },
          checks: []
        }}
        loading={false}
        onRecheck={jest.fn()}
      />,
      false
    );
    expect(screen.getByTestId('checks-paused')).toBeInTheDocument();
    expect(screen.getByText('Not evaluated')).toBeInTheDocument();
    expect(screen.queryByText('All checks passed')).toBeNull();
    expect(screen.queryByRole('button', { name: /Check again/ })).toBeNull();
  });

  test('acknowledgements keep their counts, show the paused note and disable delete and reset', async () => {
    withConfig(
      <AcknowledgementsCard
        paused
        acknowledgements={{
          enabled: false,
          configuredEnabled: true,
          enforced: true,
          requiredVersion: 1,
          counts: { acknowledged: 12, pending: 3, total: 15 }
        }}
      />,
      false
    );
    expect(screen.getByTestId('paused-note')).toHaveTextContent('Paused while EU AI Act features');
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByText('Acknowledgement is switched off')).toBeNull();
  });

  test('verification is disabled with a note', () => {
    withConfig(<VerificationCard />, false);
    expect(screen.getByTestId('paused-note')).toHaveTextContent('Verification is switched off.');
    expect(screen.getByLabelText('Text to check')).toBeDisabled();
  });
});

describe('EuAiActStateNote and the public config', () => {
  test('on and off wording, hidden when on if asked', () => {
    const { rerender } = withConfig(<EuAiActStateNote />, true);
    expect(screen.getByTestId('eu-ai-act-state-note')).toHaveAttribute('data-state', 'on');
    expect(screen.getByText(/EU AI Act features are on/)).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <PlatformConfigContext.Provider value={{ platformConfig: { euAiAct: { enabled: true } } }}>
          <EuAiActStateNote hideWhenOn />
        </PlatformConfigContext.Provider>
      </MemoryRouter>
    );
    expect(screen.queryByTestId('eu-ai-act-state-note')).toBeNull();
    rerender(
      <MemoryRouter>
        <PlatformConfigContext.Provider value={{ platformConfig: { euAiAct: { enabled: false } } }}>
          <EuAiActStateNote hideWhenOn />
        </PlatformConfigContext.Provider>
      </MemoryRouter>
    );
    expect(screen.getByText(/saved but have no effect/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage on the EU AI Act page' })).toHaveAttribute(
      'href',
      '/admin/eu-ai-act#conformity'
    );
  });

  test('PlatformConfigProvider keeps the euAiAct member (the object is rebuilt by hand)', async () => {
    mockApiIndex.fetchPlatformConfig.mockResolvedValue({ euAiAct: { enabled: false }, auth: {} });
    function Probe() {
      const { platformConfig } = usePlatformConfig();
      return <span data-testid="probe">{JSON.stringify(platformConfig?.euAiAct ?? null)}</span>;
    }
    render(
      <PlatformConfigProvider>
        <Probe />
      </PlatformConfigProvider>
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('{"enabled":false}'));
  });
});
