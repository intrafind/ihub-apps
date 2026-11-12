// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → EU AI Act → Provenance settings: defaults and units shown, the same
 * bounds as the server, errors tied to their fields, a consequence dialog for a
 * lowered retention and for the verify access, a save that sends a partial block,
 * and a server error shown on its field.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockAdminCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...a) => mockAdminCall(...a),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));
const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

import ProvenanceSettingsCard from '../../../client/src/features/admin/components/euAiAct/ProvenanceSettingsCard';
import {
  buildBody,
  consequences,
  toForm,
  validateForm
} from '../../../client/src/features/admin/components/euAiAct/provenanceSettingsForm';

const STORED = {
  chats: { enabled: true },
  provenance: {
    retentionDays: 365,
    storeRecords: true,
    verify: { access: 'authenticated' },
    media: { maxVerifyBytes: 52428800, readC2pa: true },
    watermark: { minScoredTokens: 300 }
  }
};

function setup(provenance = STORED.provenance) {
  mockAdminCall.mockImplementation(async (url, options = {}) => {
    if (options.method === 'POST') {
      return { data: { config: { ...STORED, provenance: options.body.provenance } } };
    }
    return { data: { ...STORED, provenance } };
  });
  const onSaved = jest.fn();
  render(<ProvenanceSettingsCard onSaved={onSaved} />);
  return { onSaved };
}
const posts = () => mockAdminCall.mock.calls.filter(([, o]) => o?.method === 'POST');
const change = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => jest.clearAllMocks());

describe('provenance settings form helpers', () => {
  test('bytes are shown as MiB and an untouched size is saved byte-exact', () => {
    const form = toForm({ media: { maxVerifyBytes: 1234567 } });
    expect(buildBody(form).media.maxVerifyBytes).toBe(1234567);
    expect(buildBody({ ...form, maxVerifyMib: '2' }).media.maxVerifyBytes).toBe(2 * 1024 * 1024);
    expect(toForm({}).maxVerifyMib).toBe('50');
  });

  test('empty watermark fields mean "default" (null); bounds match the server', () => {
    const form = toForm({});
    expect(buildBody(form).watermark).toEqual({
      alpha: null,
      minScoredTokens: null,
      detectorTimeoutMs: null
    });
    expect(validateForm(form)).toEqual({});
    expect(validateForm({ ...form, retentionDays: '-1' }).retentionDays).toBe('min');
    expect(validateForm({ ...form, retentionDays: '1.5' }).retentionDays).toBe('integer');
    expect(validateForm({ ...form, retentionDays: '36501' }).retentionDays).toBe('max');
    expect(validateForm({ ...form, retentionDays: '' }).retentionDays).toBe('required');
    expect(validateForm({ ...form, alpha: '0' }).alpha).toBe('min');
    expect(validateForm({ ...form, alpha: '1' }).alpha).toBe('max');
    expect(validateForm({ ...form, alpha: 'abc' }).alpha).toBe('number');
    expect(validateForm({ ...form, detectorTimeoutMs: '999' }).detectorTimeoutMs).toBe('min');
    expect(validateForm({ ...form, maxVerifyMib: '0.0001' }).maxVerifyBytes).toBe('min');
    expect(validateForm({ ...form, maxVerifyMib: '1025' }).maxVerifyBytes).toBe('max');
  });

  test('consequences: lowering the retention (also from "forever") and changing the access', () => {
    const saved = toForm({ retentionDays: 365 });
    expect(consequences({ ...saved, retentionDays: '30' }, saved).retentionLowered).toBe(true);
    expect(consequences({ ...saved, retentionDays: '400' }, saved).retentionLowered).toBe(false);
    expect(consequences({ ...saved, retentionDays: '0' }, saved).retentionLowered).toBe(false);
    const forever = toForm({ retentionDays: 0 });
    expect(consequences({ ...forever, retentionDays: '30' }, forever).retentionLowered).toBe(true);
    expect(consequences({ ...saved, verifyAccess: 'public' }, saved).accessPublic).toBe(true);
    const open = toForm({ verify: { access: 'public' } });
    expect(consequences({ ...open, verifyAccess: 'authenticated' }, open).accessRestricted).toBe(
      true
    );
  });
});

describe('ProvenanceSettingsCard', () => {
  test('shows the stored values with units and defaults; empty tunables use placeholders', async () => {
    setup();
    expect(await screen.findByLabelText(/Keep records for/)).toHaveValue(365);
    expect(screen.getByLabelText(/Largest file that can be checked/)).toHaveValue(50);
    expect(screen.getByText(/Default: 50 MiB\./)).toBeInTheDocument();
    expect(screen.getByLabelText(/Shortest text that can be judged/)).toHaveValue(300);
    expect(screen.getByLabelText(/False-positive limit/)).toHaveAttribute('placeholder', '0.0001');
    expect(screen.getByText(/No restart is needed|no restart is needed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('invalid input: field-tied errors, nothing is sent, the first bad field gets focus', async () => {
    setup();
    await screen.findByLabelText(/Keep records for/);
    change(/Keep records for/, '-3');
    change(/False-positive limit/, '2');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const retention = screen.getByLabelText(/Keep records for/);
    expect(retention).toHaveAttribute('aria-invalid', 'true');
    expect(retention.getAttribute('aria-describedby')).toContain('provenance-retentionDays-error');
    expect(document.getElementById('provenance-retentionDays-error')).toHaveTextContent(
      'Enter 0 or more.'
    );
    expect(screen.getByLabelText(/False-positive limit/)).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(retention);
    expect(posts()).toHaveLength(0);
    // Editing a field clears its error.
    change(/Keep records for/, '400');
    expect(screen.getByLabelText(/Keep records for/)).not.toHaveAttribute('aria-invalid');
  });

  test('a harmless change saves at once: partial provenance block on top of the fresh platform file, then the status refreshes', async () => {
    const { onSaved } = setup();
    await screen.findByLabelText(/Keep records for/);
    change(/Keep records for/, '400');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Settings saved/);
    const [[url, options]] = posts();
    expect(url).toBe('/admin/configs/platform');
    expect(options.body.chats).toEqual(STORED.chats);
    expect(options.body.provenance).toEqual({
      retentionDays: 400,
      storeRecords: true,
      recordUser: 'none',
      verify: { access: 'authenticated' },
      media: { maxVerifyBytes: 52428800, readC2pa: true },
      watermark: { alpha: null, minScoredTokens: 300, detectorTimeoutMs: null }
    });
    expect(onSaved).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('who a record names: four choices, "Nobody" by default, saved as recordUser', async () => {
    setup();
    await screen.findByLabelText(/Keep records for/);
    expect(screen.getByLabelText('Nobody')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Identified (user id)'));
    expect(screen.getByLabelText('Identified (user id)')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Settings saved/);
    const [[, options]] = posts();
    expect(options.body.provenance.recordUser).toBe('identified');
  });

  test('lowering the retention asks first, names the days and the irreversibility; Cancel saves nothing', async () => {
    setup();
    await screen.findByLabelText(/Keep records for/);
    change(/Keep records for/, '30');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = screen.getByText('Save these settings?').closest('[role="alertdialog"]');
    expect(
      within(dialog).getByText(/older than 30 days are deleted at the next daily clean-up/)
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(
      within(screen.getByText('Save these settings?').closest('[role="alertdialog"]')).getByRole(
        'button',
        { name: 'Save' }
      )
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][1].body.provenance.retentionDays).toBe(30);
  });

  test('switching the check to "anyone" shows the public consequence before saving', async () => {
    setup();
    await screen.findByLabelText(/Keep records for/);
    fireEvent.click(screen.getByLabelText('Anyone, without signing in'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      screen.getByText(/Anyone on the internet can then check texts and files/)
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('a server validation error is shown on its field and the form keeps the input', async () => {
    mockAdminCall.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') {
        throw {
          response: {
            data: {
              detail: 'Invalid provenance settings',
              errors: [{ field: 'media.maxVerifyBytes', message: 'Too big for this server' }]
            }
          }
        };
      }
      return { data: STORED };
    });
    render(<ProvenanceSettingsCard />);
    await screen.findByLabelText(/Keep records for/);
    change(/Largest file that can be checked/, '100');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/The settings were not saved\./);
    expect(document.getElementById('provenance-maxVerifyBytes-error')).toHaveTextContent(
      'Too big for this server'
    );
    expect(screen.getByLabelText(/Largest file that can be checked/)).toHaveValue(100);
  });

  test('a load error offers Retry', async () => {
    mockAdminCall.mockRejectedValueOnce({ message: 'down' });
    render(<ProvenanceSettingsCard />);
    expect(await screen.findByText('Could not load the settings')).toBeInTheDocument();
    mockAdminCall.mockResolvedValue({ data: STORED });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText(/Keep records for/)).toBeInTheDocument();
  });
});
