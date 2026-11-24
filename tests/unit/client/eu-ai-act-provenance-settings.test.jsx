// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → EU AI Act → Provenance settings: defaults and units shown, the same
 * bounds as the server, errors tied to their fields, a consequence dialog for a
 * lowered retention and for the verify access, a save that sends a partial block,
 * and a server error shown on its field. The watermark sections of the block
 * (gateway, thresholds) are forms of their own in the card "Text watermark", each
 * saving only its fields.
 */
import '@testing-library/jest-dom';
import { fireEvent, render as renderPlain, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The card links to the credentials page, as it does inside the admin area.
const render = ui => renderPlain(<MemoryRouter>{ui}</MemoryRouter>);

const mockAdminCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...a) => mockAdminCall(...a),
  listCredentials: () =>
    Promise.resolve([
      { id: 'ifinder-gateway', type: 'oauth2', name: 'iFinder gateway' },
      { id: 'basic-x', type: 'basic', name: 'Basic' }
    ]),
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

import {
  SaveSectionsBar,
  SaveSectionsProvider
} from '../../../client/src/features/admin/components/SaveSections';
import ProvenanceSettingsCard, {
  ProvenanceSettingsForm
} from '../../../client/src/features/admin/components/euAiAct/ProvenanceSettingsCard';
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
    if (options.method === 'PATCH') {
      return { data: { ...STORED, provenance: options.body.provenance } };
    }
    return { data: { ...STORED, provenance } };
  });
  const onSaved = jest.fn();
  render(<Page onSaved={onSaved} />);
  return { onSaved };
}
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

/** The card as the EU AI Act page shows it: its save is the page's bottom bar. */
function Page(props) {
  return (
    <SaveSectionsProvider>
      <ProvenanceSettingsCard {...props} />
      <SaveSectionsBar />
    </SaveSectionsProvider>
  );
}
const barSave = () =>
  within(screen.getByRole('region', { name: 'Save changes' })).getByRole('button', {
    name: 'Save Changes'
  });
const posts = () => mockAdminCall.mock.calls.filter(([, o]) => o?.method === 'PATCH');
const change = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => jest.clearAllMocks());

describe('provenance settings form helpers', () => {
  test('bytes are shown as MiB and an untouched size is saved byte-exact', () => {
    const form = toForm({ media: { maxVerifyBytes: 1234567 } });
    expect(buildBody(form, 'provenance').media.maxVerifyBytes).toBe(1234567);
    expect(buildBody({ ...form, maxVerifyMib: '2' }, 'provenance').media.maxVerifyBytes).toBe(
      2 * 1024 * 1024
    );
    expect(toForm({}).maxVerifyMib).toBe('50');
  });

  test('empty watermark fields mean "default" (null); bounds match the server', () => {
    const form = toForm({});
    expect(buildBody(form, 'thresholds')).toEqual({
      watermark: { alpha: null, minScoredTokens: null, detectorTimeoutMs: null }
    });
    expect(buildBody(form, 'gateway')).toEqual({
      watermark: { gatewayUrl: null, gatewayCredentialRef: null }
    });
    expect(buildBody(form, 'provenance')).not.toHaveProperty('watermark');
    expect(validateForm(form, 'provenance')).toEqual({});
    const records = field => validateForm({ ...form, ...field }, 'provenance');
    expect(records({ retentionDays: '-1' }).retentionDays).toBe('min');
    expect(records({ retentionDays: '1.5' }).retentionDays).toBe('integer');
    expect(records({ retentionDays: '36501' }).retentionDays).toBe('max');
    expect(records({ retentionDays: '' }).retentionDays).toBe('required');
    expect(records({ maxVerifyMib: '0.0001' }).maxVerifyBytes).toBe('min');
    expect(records({ maxVerifyMib: '1025' }).maxVerifyBytes).toBe('max');
    const thresholds = field => validateForm({ ...form, ...field }, 'thresholds');
    expect(thresholds({ alpha: '0' }).alpha).toBe('min');
    expect(thresholds({ alpha: '1' }).alpha).toBe('max');
    expect(thresholds({ alpha: 'abc' }).alpha).toBe('number');
    expect(thresholds({ detectorTimeoutMs: '999' }).detectorTimeoutMs).toBe('min');
  });

  test('a section only answers for its own fields', () => {
    const form = { ...toForm({}), alpha: '2', retentionDays: '-1', gatewayUrl: 'ftp://x' };
    expect(validateForm(form, 'provenance')).toEqual({ retentionDays: 'min' });
    expect(validateForm(form, 'thresholds')).toEqual({ alpha: 'max' });
    expect(validateForm(form, 'gateway')).toEqual({ gatewayUrl: 'url' });
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
    // The watermark settings are in the card "Text watermark".
    expect(screen.queryByLabelText(/False-positive limit/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Detection endpoint/)).not.toBeInTheDocument();
    expect(screen.getByText(/No restart is needed|no restart is needed/i)).toBeInTheDocument();
    // Nothing changed: no save bar.
    expect(screen.queryByRole('region', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  test('invalid input: field-tied errors, nothing is sent, the first bad field gets focus', async () => {
    setup();
    await screen.findByLabelText(/Keep records for/);
    change(/Keep records for/, '-3');
    change(/Largest file that can be checked/, '5000');
    fireEvent.click(barSave());
    const retention = screen.getByLabelText(/Keep records for/);
    expect(retention).toHaveAttribute('aria-invalid', 'true');
    expect(retention.getAttribute('aria-describedby')).toContain('provenance-retentionDays-error');
    expect(document.getElementById('provenance-retentionDays-error')).toHaveTextContent(
      'Enter 0 or more.'
    );
    expect(screen.getByLabelText(/Largest file that can be checked/)).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(document.activeElement).toBe(retention);
    expect(posts()).toHaveLength(0);
    // Editing a field clears its error.
    change(/Keep records for/, '400');
    expect(screen.getByLabelText(/Keep records for/)).not.toHaveAttribute('aria-invalid');
  });

  test('a harmless change saves at once: a scoped PATCH of the partial provenance block only, then the status refreshes', async () => {
    const { onSaved } = setup();
    await screen.findByLabelText(/Keep records for/);
    change(/Keep records for/, '400');
    fireEvent.click(barSave());
    await screen.findByText(/Settings saved/);
    const [[url, options]] = posts();
    expect(url).toBe('/admin/configs/platform');
    expect(Object.keys(options.body)).toEqual(['provenance']);
    expect(options.body.provenance).toEqual({
      retentionDays: 400,
      storeRecords: true,
      recordUser: 'none',
      verify: { access: 'authenticated' },
      media: { maxVerifyBytes: 52428800, readC2pa: true }
    });
    expect(onSaved).toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  test('who a record names: four choices, "Nobody" by default, saved as recordUser', async () => {
    setup();
    await screen.findByLabelText(/Keep records for/);
    expect(screen.getByLabelText('Nobody')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Identified (user id)'));
    expect(screen.getByLabelText('Identified (user id)')).toBeChecked();
    fireEvent.click(barSave());
    await screen.findByText(/Settings saved/);
    const [[, options]] = posts();
    expect(options.body.provenance.recordUser).toBe('identified');
  });

  test('lowering the retention asks first, names the days and the irreversibility; Cancel saves nothing', async () => {
    setup();
    await screen.findByLabelText(/Keep records for/);
    change(/Keep records for/, '30');
    fireEvent.click(barSave());
    const dialog = screen.getByText('Save these settings?').closest('[role="alertdialog"]');
    expect(
      within(dialog).getByText(/older than 30 days are deleted at the next daily clean-up/)
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posts()).toHaveLength(0);
    // Cancelling ends the bar's save: Save is offered again.
    await waitFor(() => expect(barSave()).toBeEnabled());
    fireEvent.click(barSave());
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
    fireEvent.click(barSave());
    expect(
      screen.getByText(/Anyone on the internet can then check texts and files/)
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('a server validation error is shown on its field and the form keeps the input', async () => {
    mockAdminCall.mockImplementation(async (url, options = {}) => {
      if (options.method === 'PATCH') {
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
    render(<Page />);
    await screen.findByLabelText(/Keep records for/);
    change(/Largest file that can be checked/, '100');
    fireEvent.click(barSave());
    // Said by the card and, as the reason the bar stays, by the bar.
    expect(await screen.findAllByText(/The settings were not saved\./)).toHaveLength(2);
    expect(document.getElementById('provenance-maxVerifyBytes-error')).toHaveTextContent(
      'Too big for this server'
    );
    expect(screen.getByLabelText(/Largest file that can be checked/)).toHaveValue(100);
  });

  test('a load error offers Retry', async () => {
    mockAdminCall.mockRejectedValueOnce({ message: 'down' });
    render(<Page />);
    expect(await screen.findByText('Could not load the settings')).toBeInTheDocument();
    mockAdminCall.mockResolvedValue({ data: STORED });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText(/Keep records for/)).toBeInTheDocument();
  });
});

describe('watermark settings forms', () => {
  const renderSection = section => {
    mockAdminCall.mockImplementation(async (url, options = {}) => {
      if (options.method === 'PATCH') return { data: STORED };
      return { data: STORED };
    });
    const onSaved = jest.fn();
    render(
      <SaveSectionsProvider>
        <ProvenanceSettingsForm section={section} onSaved={onSaved} />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    return { onSaved };
  };

  test('thresholds: stored value, default as placeholder, a save of the thresholds only', async () => {
    const { onSaved } = renderSection('thresholds');
    expect(await screen.findByLabelText(/Shortest text that can be judged/)).toHaveValue(300);
    expect(screen.getByLabelText(/False-positive limit/)).toHaveAttribute('placeholder', '0.0001');
    expect(screen.queryByLabelText(/Keep records for/)).not.toBeInTheDocument();
    change(/False-positive limit/, '0.05');
    fireEvent.click(barSave());
    await screen.findByText(/Settings saved/);
    expect(posts()[0][1].body).toEqual({
      provenance: {
        watermark: { alpha: 0.05, minScoredTokens: 300, detectorTimeoutMs: null }
      }
    });
    expect(onSaved).toHaveBeenCalled();
  });

  test('gateway: a save of the gateway only; a bad address stays local', async () => {
    renderSection('gateway');
    const field = await screen.findByLabelText(/Detection endpoint/);
    fireEvent.change(field, { target: { value: 'ftp://gateway' } });
    fireEvent.click(barSave());
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(posts()).toHaveLength(0);
    fireEvent.change(field, {
      target: { value: 'https://gateway.internal/v1/gateway/detections/text' }
    });
    await waitFor(() => expect(barSave()).toBeEnabled());
    fireEvent.click(barSave());
    await screen.findByText(/Settings saved/);
    expect(posts()[0][1].body).toEqual({
      provenance: {
        watermark: {
          gatewayUrl: 'https://gateway.internal/v1/gateway/detections/text',
          gatewayCredentialRef: null
        }
      }
    });
  });

  test('a gateway address is checked, saved with its credential, and empty means none', () => {
    const form = toForm({
      watermark: {
        gatewayUrl: 'https://gateway.internal/v1/gateway/detections/text',
        gatewayCredentialRef: 'ifinder-gateway'
      }
    });
    expect(buildBody(form, 'gateway').watermark).toEqual({
      gatewayUrl: 'https://gateway.internal/v1/gateway/detections/text',
      gatewayCredentialRef: 'ifinder-gateway'
    });
    expect(validateForm({ ...form, gatewayUrl: 'ftp://gateway' }, 'gateway')).toEqual({
      gatewayUrl: 'url'
    });
    // Without a gateway, a credential means nothing and is not saved.
    expect(buildBody({ ...form, gatewayUrl: ' ' }, 'gateway').watermark).toEqual({
      gatewayUrl: null,
      gatewayCredentialRef: null
    });
  });
});
