// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → EU AI Act (#3329): traffic lights as icon plus word, fix links, the
 * watermark key dialogs (a key is in the DOM only while shown, auto-hides, copy
 * fallback), delete only after confirmation, the acknowledgement counts with
 * the shared actions, and verification wording that never over-claims.
 *
 * Only the API modules and the translation hook are stubbed.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  fetchWatermarkKeys: jest.fn(),
  fetchWatermarkDetectors: jest.fn(),
  createWatermarkKey: jest.fn(),
  revealWatermarkKey: jest.fn(),
  deleteWatermarkKey: jest.fn(),
  activateWatermarkKey: jest.fn(),
  testWatermarkDetector: jest.fn(),
  runWatermarkSelfTest: jest.fn(),
  verifyText: jest.fn(),
  verifyFile: jest.fn(),
  fetchEuAiActStatus: jest.fn()
};
jest.mock('../../../client/src/api/euAiActAdminApi', () => ({
  __esModule: true,
  fetchWatermarkKeys: (...a) => mockApi.fetchWatermarkKeys(...a),
  fetchWatermarkDetectors: (...a) => mockApi.fetchWatermarkDetectors(...a),
  createWatermarkKey: (...a) => mockApi.createWatermarkKey(...a),
  revealWatermarkKey: (...a) => mockApi.revealWatermarkKey(...a),
  deleteWatermarkKey: (...a) => mockApi.deleteWatermarkKey(...a),
  activateWatermarkKey: (...a) => mockApi.activateWatermarkKey(...a),
  testWatermarkDetector: (...a) => mockApi.testWatermarkDetector(...a),
  runWatermarkSelfTest: (...a) => mockApi.runWatermarkSelfTest(...a),
  verifyText: (...a) => mockApi.verifyText(...a),
  verifyFile: (...a) => mockApi.verifyFile(...a),
  fetchEuAiActStatus: (...a) => mockApi.fetchEuAiActStatus(...a)
}));
const mockAdminCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...a) => mockAdminCall(...a),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
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

import CheckStatus from '../../../client/src/features/admin/components/euAiAct/CheckStatus';
import ConfigCheckCard from '../../../client/src/features/admin/components/euAiAct/ConfigCheckCard';
import WatermarkKeysCard from '../../../client/src/features/admin/components/euAiAct/WatermarkKeysCard';
import AcknowledgementsCard from '../../../client/src/features/admin/components/euAiAct/AcknowledgementsCard';
import VerificationCard from '../../../client/src/features/admin/components/euAiAct/VerificationCard';
import { summarizeVerification } from '../../../client/src/features/admin/components/euAiAct/verificationResult';

const SECRET = '123456789012345';
const SNIPPET = `--watermark-config '{"algorithm":"gumbel","key":${SECRET}}'`;
const BANNED = /not watermarked|human-written|authentic|no synthid/i;

const renderInRouter = ui => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchWatermarkDetectors.mockResolvedValue({ items: [] });
  mockApi.fetchWatermarkKeys.mockResolvedValue({
    items: [
      { keyId: 'wm-2026-2', status: 'active', createdAt: '2026-11-01T00:00:00Z' },
      { keyId: 'wm-2026-1', status: 'retired', createdAt: '2026-09-01T00:00:00Z' }
    ]
  });
});

describe('CheckStatus', () => {
  test.each([
    ['ok', 'OK'],
    ['warn', 'Attention'],
    ['error', 'Failing'],
    ['off', 'Off']
  ])('%s shows the word %s, not only a colour', (level, word) => {
    render(<CheckStatus level={level} />);
    expect(screen.getByText(word)).toBeInTheDocument();
  });
});

describe('ConfigCheckCard', () => {
  const status = {
    generatedAt: '2026-11-11T09:00:00Z',
    summary: { level: 'error', counts: { ok: 1, warn: 1, error: 1 }, skippedDisabledModels: 2 },
    checks: [
      { id: 'a', level: 'ok', messageKey: 'k.a', message: 'All fine here.', params: {}, fix: null },
      {
        id: 'model.watermark.key',
        level: 'error',
        modelId: 'vl',
        messageKey: 'k.b',
        message: 'No active key for {{model}}.',
        params: { model: 'Llama' },
        fix: { href: '/admin/eu-ai-act#watermark-keys', labelKey: 'admin.euAiAct.fix.openKeys' }
      },
      {
        id: 'model.marking.text',
        level: 'warn',
        modelId: 'g',
        messageKey: 'k.c',
        message: 'Not marked.',
        params: {},
        fix: { href: '/admin/models/g', labelKey: 'admin.euAiAct.fix.openModel' }
      }
    ]
  };

  // The stubbed `t` returns the fallback ("Open") for the fix label keys.
  test('lists the worst first, with a fix link per row and the honesty note', () => {
    renderInRouter(<ConfigCheckCard status={status} onRecheck={jest.fn()} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Failing');
    expect(rows[0]).toHaveTextContent('No active key for Llama.');
    expect(rows[2]).toHaveTextContent('OK');
    expect(screen.getByRole('link', { name: /Open: Not marked/ })).toHaveAttribute(
      'href',
      '/admin/models/g'
    );
    expect(screen.getByRole('link', { name: /Open: No active key/ })).toHaveAttribute(
      'href',
      '/admin/eu-ai-act#watermark-keys'
    );
    expect(screen.getByText(/not "legally compliant"/)).toBeInTheDocument();
    expect(screen.getByText('1 failing')).toBeInTheDocument();
    expect(screen.getByText(/2 disabled models/)).toBeInTheDocument();
  });

  test('the re-check button asks for a refresh', () => {
    const onRecheck = jest.fn();
    renderInRouter(<ConfigCheckCard status={status} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRecheck).toHaveBeenCalledWith({ refresh: true });
  });

  test('shows an error with Retry when nothing loaded, and a loading label first', () => {
    const onRecheck = jest.fn();
    const { rerender } = renderInRouter(
      <ConfigCheckCard status={null} error="boom" onRecheck={onRecheck} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRecheck).toHaveBeenCalled();
    rerender(
      <MemoryRouter>
        <ConfigCheckCard status={null} loading onRecheck={onRecheck} />
      </MemoryRouter>
    );
    expect(screen.getByText('Loading checks')).toBeInTheDocument();
  });

  test('all green says "All checks passed"', () => {
    renderInRouter(
      <ConfigCheckCard
        status={{ ...status, summary: { counts: { ok: 3, warn: 0, error: 0 } }, checks: [] }}
        onRecheck={jest.fn()}
      />
    );
    expect(screen.getByText('All checks passed')).toBeInTheDocument();
  });
});

describe('WatermarkKeysCard', () => {
  test('lists keys without any key value; the active key has no Delete', async () => {
    const { container } = renderInRouter(<WatermarkKeysCard statusModels={[]} />);
    await screen.findByText('wm-2026-2');
    expect(container.textContent).not.toContain(SECRET);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Retired (detection only)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete key wm-2026-2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete key wm-2026-1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal key wm-2026-2' })).toBeInTheDocument();
  });

  test('generate confirms first when a key is active, shows the key once, drops it on Done', async () => {
    mockApi.createWatermarkKey.mockResolvedValue({
      keyId: 'wm-2026-3',
      status: 'active',
      key: SECRET,
      vllmConfigSnippet: SNIPPET
    });
    renderInRouter(<WatermarkKeysCard statusModels={[]} />);
    await screen.findByText('wm-2026-2');
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }));
    // The confirmation names the key that gets retired; nothing is created yet.
    expect(screen.getByText(/wm-2026-2 becomes retired/)).toBeInTheDocument();
    expect(mockApi.createWatermarkKey).not.toHaveBeenCalled();
    const confirm = screen.getAllByRole('button', { name: 'Generate key' }).pop();
    fireEvent.click(confirm);
    const dialog = await screen.findByRole('dialog', { name: /New watermark key wm-2026-3/ });
    expect(within(dialog).getByText(SECRET)).toBeInTheDocument();
    expect(within(dialog).getByText(SNIPPET)).toBeInTheDocument();
    expect(screen.getByText(/wm-2026-3 is now active/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test('a revealed key hides itself after the time limit and can be revealed again', async () => {
    jest.useFakeTimers();
    try {
      mockApi.revealWatermarkKey.mockResolvedValue({
        keyId: 'wm-2026-1',
        key: SECRET,
        vllmConfigSnippet: SNIPPET
      });
      renderInRouter(<WatermarkKeysCard statusModels={[]} />);
      await act(async () => {
        await Promise.resolve();
      });
      await screen.findByText('wm-2026-1');
      fireEvent.click(screen.getByRole('button', { name: 'Reveal key wm-2026-1' }));
      await screen.findByText(SECRET);
      expect(screen.getByText(/Key shown. This was recorded/)).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(document.body.textContent).not.toContain(SECRET);
      expect(screen.getByText('The key is hidden.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Reveal again' }));
      await screen.findByText(SECRET);
      expect(mockApi.revealWatermarkKey).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('copy falls back to selecting the text when the clipboard is not available', async () => {
    mockApi.revealWatermarkKey.mockResolvedValue({
      keyId: 'wm-2026-2',
      key: SECRET,
      vllmConfigSnippet: SNIPPET
    });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    renderInRouter(<WatermarkKeysCard statusModels={[]} />);
    await screen.findByText('wm-2026-2');
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key wm-2026-2' }));
    await screen.findByText(SECRET);
    fireEvent.click(screen.getByRole('button', { name: 'Copy option' }));
    await waitFor(() =>
      expect(screen.getAllByText(/Copy failed. The text is selected/).length).toBeGreaterThan(0)
    );
  });

  test('deleting a retired key names it, warns, and calls DELETE only after the confirmation', async () => {
    mockApi.deleteWatermarkKey.mockResolvedValue();
    renderInRouter(<WatermarkKeysCard statusModels={[]} />);
    await screen.findByText('wm-2026-1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete key wm-2026-1' }));
    expect(screen.getByText('Delete retired key wm-2026-1?')).toBeInTheDocument();
    expect(screen.getByText(/can no longer be recognised as watermarked/)).toBeInTheDocument();
    expect(mockApi.deleteWatermarkKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(mockApi.deleteWatermarkKey).toHaveBeenCalledWith('wm-2026-1'));
  });

  test('Make active is offered on retired keys only, states the consequences and calls _activate after the confirmation', async () => {
    mockApi.activateWatermarkKey.mockResolvedValue({ keyId: 'wm-2026-1', status: 'active' });
    const onChanged = jest.fn();
    const { container } = renderInRouter(
      <WatermarkKeysCard statusModels={[]} onChanged={onChanged} />
    );
    await screen.findByText('wm-2026-1');
    expect(screen.queryByRole('button', { name: 'Make key wm-2026-2 active' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make key wm-2026-1 active' }));
    const dialog = screen.getByText('Make key wm-2026-1 active?').closest('[role="alertdialog"]');
    expect(
      within(dialog).getByText(/wm-2026-2 becomes retired and is used for detection only/)
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/--watermark-config of your vLLM server/)).toBeInTheDocument();
    expect(within(dialog).getByText(/self-test shows a mismatch/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Earlier self-test results become outdated/)
    ).toBeInTheDocument();
    expect(mockApi.activateWatermarkKey).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make active' }));
    await waitFor(() => expect(mockApi.activateWatermarkKey).toHaveBeenCalledWith('wm-2026-1'));
    await screen.findByText(/Key wm-2026-1 is now active. wm-2026-2 is retired./);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // The key value is not in the page until the admin asks for it.
    expect(container.textContent).not.toContain(SECRET);
    expect(mockApi.revealWatermarkKey).not.toHaveBeenCalled();
    mockApi.revealWatermarkKey.mockResolvedValue({
      keyId: 'wm-2026-1',
      key: SECRET,
      vllmConfigSnippet: SNIPPET
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show key and vLLM option' }));
    await screen.findByText(SECRET);
    expect(mockApi.revealWatermarkKey).toHaveBeenCalledWith('wm-2026-1');
  });

  test('Make active: cancel calls nothing; a 404 says the key is gone and refreshes the list', async () => {
    mockApi.activateWatermarkKey.mockRejectedValue({ response: { status: 404 }, message: 'x' });
    renderInRouter(<WatermarkKeysCard statusModels={[]} />);
    await screen.findByText('wm-2026-1');
    fireEvent.click(screen.getByRole('button', { name: 'Make key wm-2026-1 active' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockApi.activateWatermarkKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Make key wm-2026-1 active' }));
    const calls = mockApi.fetchWatermarkKeys.mock.calls.length;
    fireEvent.click(
      within(
        screen.getByText('Make key wm-2026-1 active?').closest('[role="alertdialog"]')
      ).getByRole('button', { name: 'Make active' })
    );
    await screen.findByText(/Key wm-2026-1 no longer exists. The list was refreshed./);
    expect(mockApi.fetchWatermarkKeys.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.queryByText(/Next: update the --watermark-config/)).toBeNull();
  });

  test('add own key validates digits, then posts and shows the result', async () => {
    mockApi.createWatermarkKey.mockResolvedValue({
      keyId: 'wm-2026-3',
      key: '42',
      weakKey: true,
      vllmConfigSnippet: '--watermark-config {}'
    });
    renderInRouter(<WatermarkKeysCard statusModels={[]} />);
    await screen.findByText('wm-2026-2');
    fireEvent.click(screen.getByRole('button', { name: 'Add own key…' }));
    const input = screen.getByLabelText('Key (whole number)');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    expect(screen.getByRole('alert')).toHaveTextContent('digits only');
    expect(mockApi.createWatermarkKey).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    await screen.findByRole('dialog', { name: /New watermark key wm-2026-3/ });
    expect(mockApi.createWatermarkKey).toHaveBeenCalledWith({ key: '42', label: '' });
    expect(screen.getByText(/short or easy to guess/)).toBeInTheDocument();
  });

  test('self-test: shows progress, then the diagnosis in words, and tells the page to refresh', async () => {
    mockApi.fetchWatermarkDetectors.mockResolvedValue({
      items: [
        {
          modelId: 'vl',
          detectorUrl: 'https://det.example',
          credentialRef: 'wm',
          urlPolicyOk: true
        }
      ]
    });
    let finish;
    mockApi.runWatermarkSelfTest.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const onChanged = jest.fn();
    renderInRouter(<WatermarkKeysCard statusModels={[]} onChanged={onChanged} />);
    await screen.findByText('https://det.example');
    fireEvent.click(screen.getByRole('button', { name: /Run self-test/ }));
    expect(await screen.findByText(/Generating sample text/)).toBeInTheDocument();
    await act(async () => {
      finish({ ok: false, diagnosis: 'matches_retired_key', matchedKeyId: 'wm-2026-1' });
    });
    expect(await screen.findByText(/matches the retired key wm-2026-1/)).toBeInTheDocument();
    expect(screen.getByText('Failing')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText('Uses about 400 tokens.')).toBeInTheDocument();
  });
});

describe('AcknowledgementsCard', () => {
  beforeEach(() => {
    mockAdminCall.mockImplementation(async url => {
      if (url === '/admin/configs/platform') {
        return {
          data: { aiAcknowledgement: { enabled: true, enforce: true, requiredVersion: 3 } }
        };
      }
      return { data: { requiredVersion: 4 } };
    });
  });

  test('counts, mode and the shared actions (request again confirms, then calls the endpoint)', async () => {
    const onChanged = jest.fn();
    renderInRouter(
      <AcknowledgementsCard
        acknowledgements={{
          enabled: true,
          enforced: true,
          requiredVersion: 3,
          counts: { acknowledged: 41, pending: 9, total: 50 }
        }}
        onChanged={onChanged}
      />
    );
    expect(screen.getByText('41')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText(/Enforced, version 3/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open users list' })).toHaveAttribute(
      'href',
      '/admin/users'
    );
    await waitFor(() => expect(mockAdminCall).toHaveBeenCalledWith('/admin/configs/platform'));
    fireEvent.click(await screen.findByRole('button', { name: /AI acknowledgements/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Request again' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ask everyone again' }));
    await waitFor(() =>
      expect(mockAdminCall).toHaveBeenCalledWith(
        '/admin/eu-ai-act/acknowledgements/_request-again',
        {
          method: 'POST'
        }
      )
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('switched off: an empty state with a link, no actions', () => {
    renderInRouter(
      <AcknowledgementsCard
        acknowledgements={{
          enabled: false,
          enforced: false,
          requiredVersion: 1,
          counts: { acknowledged: 0, pending: 0, total: 0 }
        }}
      />
    );
    expect(screen.getByText('Acknowledgement is switched off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /AI acknowledgements/ })).toBeNull();
  });
});

describe('verification wording', () => {
  test('a text with a record is a match; a miss is not proof; too short and unavailable are no conclusion', () => {
    expect(
      summarizeVerification({ found: true, records: [{ created_at: '2026-01-01T00:00:00Z' }] })
        .headline
    ).toBe('match');
    expect(
      summarizeVerification({ found: false, watermark: { status: 'not_detected' } }).headline
    ).toBe('none');
    expect(
      summarizeVerification({ found: false, watermark: { status: 'too_short' } }).headline
    ).toBe('inconclusive');
    expect(
      summarizeVerification({ found: false, watermark: { status: 'unavailable' } }).headline
    ).toBe('inconclusive');
    expect(
      summarizeVerification({ found: false, watermark: { status: 'detected', keyId: 'k' } })
        .headline
    ).toBe('match');
  });

  test('media: C2PA present, absent, unreadable; SynthID is declared, never detected', () => {
    const base = { found: false, kind: 'image', contentHash: { alg: 'sha256', value: 'x' } };
    expect(
      summarizeVerification({ ...base, c2pa: { present: true, status: 'present', valid: true } })
        .headline
    ).toBe('match');
    expect(
      summarizeVerification({ ...base, c2pa: { present: false, status: 'absent' } }).headline
    ).toBe('none');
    expect(
      summarizeVerification({ ...base, c2pa: { present: false, status: 'unreadable' } }).headline
    ).toBe('inconclusive');
    const rows = summarizeVerification({
      ...base,
      c2pa: null,
      synthid: 'declared-not-detectable'
    }).rows;
    expect(rows.find(row => row.id === 'synthid').status).toBe('info');
  });
});

describe('VerificationCard', () => {
  test('the button is disabled with a reason until there is input', () => {
    render(<VerificationCard />);
    const button = screen.getByRole('button', { name: 'Check' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Paste a text first.')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-describedby', 'verify-disabled-reason');
  });

  test('text: too short is "Too short to tell", never "not watermarked"', async () => {
    mockApi.verifyText.mockResolvedValue({
      found: false,
      normalization: 'nfc-trim',
      watermark: { status: 'too_short', scoredTokens: 12 }
    });
    const { container } = render(<VerificationCard />);
    fireEvent.change(screen.getByLabelText('Text to check'), { target: { value: 'short text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Too short to tell')).toBeInTheDocument();
    expect(screen.getByText('No conclusion possible.')).toBeInTheDocument();
    expect(screen.getByText(/Only 12 tokens could be scored/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(BANNED);
    expect(mockApi.verifyText).toHaveBeenCalledWith('short text');
  });

  test('text: not detected says it is not proof; detected shows key id and technique', async () => {
    mockApi.verifyText.mockResolvedValueOnce({
      found: false,
      watermark: { status: 'not_detected', keysChecked: 3 }
    });
    const { container } = render(<VerificationCard />);
    fireEvent.change(screen.getByLabelText('Text to check'), { target: { value: 'some text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Not detected')).toBeInTheDocument();
    expect(
      screen.getByText(/This is not proof that the content is not AI-generated/)
    ).toBeInTheDocument();
    expect(screen.getByText(/does not show that the text is not AI-generated/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(BANNED);

    mockApi.verifyText.mockResolvedValueOnce({
      found: false,
      watermark: { status: 'detected', keyId: 'wm-2026-1', pValue: 1e-9, scoredTokens: 300 }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Match found: see details.')).toBeInTheDocument();
    expect(screen.getByText(/Key ID: wm-2026-1/)).toBeInTheDocument();
  });

  test('text: a found record is "Found" with the model and date', async () => {
    mockApi.verifyText.mockResolvedValue({
      found: true,
      records: [{ created_at: '2026-11-01T10:00:00Z', model: { id: 'llama' } }]
    });
    render(<VerificationCard />);
    fireEvent.change(screen.getByLabelText('Text to check'), { target: { value: 'exact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Found')).toBeInTheDocument();
    expect(screen.getByText(/\(llama\)/)).toBeInTheDocument();
  });

  test('text: a found record is shown in full, field by field and as JSON', async () => {
    const record = {
      spec: 'intrafind-provenance/1.0',
      ai_generated: true,
      generator: { product: 'iHub Apps', version: '5.7.0', installation_id: 'inst_abc' },
      model: { id: 'gpt-x', watermark: { by: 'none', applied: false } },
      output_id: '01JC8M2T6V0Q4W7R9XK3B5N1ZD',
      created_at: '2026-11-01T10:00:00Z',
      content_hash: { alg: 'sha-256', normalization: 'nfc-trim', value: 'f'.repeat(64) }
    };
    mockApi.verifyText.mockResolvedValue({ found: true, records: [record] });
    render(<VerificationCard />);
    fireEvent.change(screen.getByLabelText('Text to check'), { target: { value: 'exact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    const details = await screen.findByTestId('provenance-record');
    expect(screen.getByText('Provenance record')).toBeInTheDocument();
    expect(details).toHaveTextContent('01JC8M2T6V0Q4W7R9XK3B5N1ZD');
    expect(details).toHaveTextContent('gpt-x');
    expect(details).toHaveTextContent('iHub Apps 5.7.0');
    expect(details).toHaveTextContent('inst_abc');
    expect(details).toHaveTextContent('f'.repeat(64));
    expect(JSON.parse(screen.getByTestId('provenance-record-json').textContent)).toEqual(record);
  });

  test('file: a found image record shows the C2PA signer, claim generator and signing time', async () => {
    mockApi.verifyFile.mockResolvedValue({
      found: true,
      kind: 'image',
      contentHash: { alg: 'sha-256', value: 'ab' },
      records: [
        {
          output_id: 'OUT1',
          kind: 'image',
          model: {
            id: 'gemini-image',
            watermark: { by: 'provider', scheme: 'synthid', applied: true }
          },
          content_hash: {
            alg: 'sha-256',
            normalization: 'none',
            value: 'ab',
            mime_type: 'image/png'
          },
          provider_marking: {
            c2pa: {
              present: true,
              status: 'present',
              valid: true,
              issuer: 'Google LLC',
              claimGenerator: 'Imagen',
              signedAt: '2026-11-11T09:00:01Z',
              trust: 'not-evaluated'
            },
            xmp: { digitalSourceType: null },
            declared: 'synthid'
          }
        }
      ],
      c2pa: {
        present: true,
        status: 'present',
        valid: true,
        issuer: 'Google LLC',
        claimGenerator: 'Imagen',
        signedAt: '2026-11-11T09:00:01Z'
      }
    });
    const { container } = render(<VerificationCard />);
    fireEvent.click(screen.getByLabelText('Image or audio file'));
    const file = new File(['png'], 'a.png', { type: 'image/png' });
    fireEvent.change(document.getElementById('verify-file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    const details = await screen.findByTestId('provenance-record');
    expect(screen.getByText(/Made with: Imagen\./)).toBeInTheDocument();
    expect(details).toHaveTextContent('Google LLC');
    expect(details).toHaveTextContent('Imagen');
    expect(details).toHaveTextContent('synthid');
    expect(details).toHaveTextContent('(trust not evaluated)');
    expect(container.textContent).not.toMatch(BANNED);
  });

  test('file: sends the file with its kind and shows C2PA as "valid (trust not evaluated)"', async () => {
    mockApi.verifyFile.mockResolvedValue({
      found: false,
      kind: 'image',
      contentHash: { alg: 'sha256', value: 'ab' },
      c2pa: {
        present: true,
        status: 'present',
        valid: true,
        issuer: 'OpenAI',
        digitalSourceType: 'trainedAlgorithmicMedia'
      },
      synthid: 'declared-not-detectable',
      caveats: ['The signer is not checked against a trust list.']
    });
    const { container } = render(<VerificationCard />);
    fireEvent.click(screen.getByLabelText('Image or audio file'));
    const file = new File(['png'], 'a.png', { type: 'image/png' });
    fireEvent.change(document.getElementById('verify-file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText(/valid \(trust not evaluated\)/)).toBeInTheDocument();
    expect(screen.getByText('declared, not detectable')).toBeInTheDocument();
    expect(screen.getByText(/The signer is not checked/)).toBeInTheDocument();
    expect(mockApi.verifyFile).toHaveBeenCalledWith(file, 'image');
    expect(container.textContent).not.toMatch(BANNED);
  });

  test('file: too large is refused before upload, an API error keeps the input', async () => {
    render(<VerificationCard maxFileBytes={10} />);
    fireEvent.click(screen.getByLabelText('Image or audio file'));
    const big = new File(['x'.repeat(100)], 'big.png', { type: 'image/png' });
    fireEvent.change(document.getElementById('verify-file'), { target: { files: [big] } });
    expect(screen.getByRole('alert')).toHaveTextContent('larger than');
    expect(mockApi.verifyFile).not.toHaveBeenCalled();
  });

  test('an API error is shown and the text stays', async () => {
    mockApi.verifyText.mockRejectedValue({ response: { data: { detail: 'Too many requests' } } });
    render(<VerificationCard />);
    const area = screen.getByLabelText('Text to check');
    fireEvent.change(area, { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(area).toHaveValue('keep me');
  });
});
