/**
 * EU AI Act admin page shell (issue #2566, concept §8.6).
 *
 * Pins the parts of the page that carry compliance meaning:
 * - the pure helpers (tab resolution, justification length, record shapes,
 *   warning split, banner audience);
 * - the justification dialog: submit stays disabled until the trimmed
 *   justification has 10 characters, errors keep the dialog open;
 * - the banner is never rendered — or fetched — for non-admins;
 * - an acknowledged unmarked model is still shown as "Non-conforming";
 * - `?tab=` selects the tab, and arrow keys move between tabs.
 */
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/** i18n mock that interpolates `{{name}}` placeholders in the fallback. */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      const vars = typeof fallback === 'object' && fallback ? fallback : options || {};
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) =>
        vars[name] !== undefined ? String(vars[name]) : ''
      );
    },
    i18n: { language: 'en' }
  })
}));

// `runtimeBasePath` reads `import.meta.env`, which the CJS test transform
// cannot parse (Icon → DataTable pull it in).
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: path => path,
  buildPath: path => path,
  buildApiUrl: path => path,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));

// adminApi pulls in the axios client, which reads `import.meta.env`.
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.response?.data?.error || err?.message || 'error'
}));

const mockApi = {
  fetchAiTransparencyStatus: jest.fn(),
  fetchComplianceBanner: jest.fn(),
  dismissComplianceWarning: jest.fn(),
  restoreComplianceWarning: jest.fn(),
  acknowledgeUnmarkedModel: jest.fn(),
  withdrawModelAcknowledgement: jest.fn(),
  setAppDisclosureOptOut: jest.fn(),
  clearAppDisclosureOptOut: jest.fn(),
  declareAppExemption: jest.fn(),
  withdrawAppExemption: jest.fn(),
  downloadComplianceReport: jest.fn()
};
jest.mock('../../../client/src/api/aiTransparencyAdminApi', () => ({
  __esModule: true,
  ...Object.fromEntries(
    Object.keys(mockApi).map(name => [name, (...args) => mockApi[name](...args)])
  )
}));

let mockUser = null;
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser })
}));

// The settings, certificates and detection tabs are separate components; the
// shell only has to mount the right one with `{ status, reload }`.
jest.mock(
  '../../../client/src/features/admin/components/euAiAct/SettingsTab',
  () => ({ __esModule: true, default: () => <div>settings tab stub</div> }),
  { virtual: true }
);
jest.mock(
  '../../../client/src/features/admin/components/euAiAct/CertificatesTab',
  () => ({ __esModule: true, default: () => <div>certificates tab stub</div> }),
  { virtual: true }
);
jest.mock(
  '../../../client/src/features/admin/components/euAiAct/DetectionTab',
  () => ({ __esModule: true, default: () => <div>detection tab stub</div> }),
  { virtual: true }
);

const utils = require('../../../client/src/features/admin/utils/euAiAct');
const JustificationDialog =
  require('../../../client/src/features/admin/components/euAiAct/JustificationDialog').default;
const ComplianceBanner =
  require('../../../client/src/features/admin/components/euAiAct/ComplianceBanner').default;
const ComplianceBannerPanel =
  require('../../../client/src/features/admin/components/euAiAct/ComplianceBannerPanel').default;
const ModelsTab =
  require('../../../client/src/features/admin/components/euAiAct/ModelsTab').default;
const AdminEuAiActPage =
  require('../../../client/src/features/admin/pages/AdminEuAiActPage').default;

const ACK = {
  acknowledgedBy: 'admin',
  acknowledgedByName: 'Ada Admin',
  acknowledgedAt: '2026-09-28T10:00:00.000Z',
  justification: 'No marking-capable alternative yet',
  installationUrl: 'https://ihub.example.com',
  installationId: 'inst_1',
  ihubVersion: '5.0.0'
};

function makeStatus(overrides = {}) {
  return {
    generatedAt: '2026-09-29T08:00:00.000Z',
    installation: {
      installationId: 'inst_1',
      installationUrl: 'https://ihub.example.com',
      ihubVersion: '5.0.0'
    },
    featureActive: true,
    conforming: false,
    checklist: [
      {
        id: 'feature',
        status: 'ok',
        detail: 'AI transparency features are on',
        fix: '/admin/features'
      },
      {
        id: 'textWatermarking',
        status: 'error',
        detail: '1 enabled model(s) do not mark free-form text over 200 tokens',
        fix: '/admin/eu-ai-act?tab=models'
      }
    ],
    models: [
      {
        id: 'gpt-x',
        name: { en: 'GPT X' },
        provider: 'openai',
        enabled: true,
        modelType: 'chat',
        text: { kind: 'none', status: 'not-marked' },
        image: null,
        notes: '',
        acknowledgement: ACK,
        conforming: false,
        issues: ['text-unmarked']
      }
    ],
    apps: [],
    warnings: [
      {
        id: 'model:gpt-x:unmarked',
        severity: 'error',
        message: 'Model "gpt-x" does not mark free-form text',
        params: { modelId: 'gpt-x' },
        stateHash: 'abc',
        dismissible: true,
        dismissal: null
      }
    ],
    activeWarnings: [],
    records: { optOuts: [], exemptions: [], acknowledgements: [], dismissals: [] },
    ...overrides
  };
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockUser = null;
});

describe('euAiAct helpers', () => {
  test('resolveEuAiActTab falls back to the overview for unknown values', () => {
    expect(utils.resolveEuAiActTab('certificates')).toBe('certificates');
    expect(utils.resolveEuAiActTab('nope')).toBe('overview');
    expect(utils.resolveEuAiActTab(null)).toBe('overview');
  });

  test('isJustificationValid trims like the server and needs 10 characters', () => {
    expect(utils.isJustificationValid('short')).toBe(false);
    expect(utils.isJustificationValid('   123456789   ')).toBe(false);
    expect(utils.isJustificationValid('1234567890')).toBe(true);
    expect(utils.isJustificationValid('x'.repeat(2001))).toBe(false);
    expect(utils.isJustificationValid(undefined)).toBe(false);
  });

  test('normalizeRecord reads every record shape the server writes', () => {
    expect(
      utils.normalizeRecord({ disabledBy: 'u1', disabledAt: 't1', reason: 'internal staff tool' })
    ).toMatchObject({ by: 'u1', at: 't1', reason: 'internal staff tool' });
    expect(
      utils.normalizeRecord({ type: 'b2bTechnical', declaredBy: 'u2', justification: 'why' })
    ).toMatchObject({ by: 'u2', type: 'b2bTechnical', reason: 'why' });
    expect(utils.normalizeRecord(ACK)).toMatchObject({
      by: 'admin',
      byName: 'Ada Admin',
      installationId: 'inst_1',
      ihubVersion: '5.0.0'
    });
    expect(utils.normalizeRecord(null)).toBeNull();
  });

  test('splitWarnings and findOutdatedDismissal', () => {
    const status = makeStatus({
      warnings: [
        { id: 'a', stateHash: '1', dismissal: null },
        { id: 'b', stateHash: '2', dismissal: { warningId: 'b', stateHash: '2' } }
      ]
    });
    const { active, dismissed } = utils.splitWarnings(status);
    expect(active.map(w => w.id)).toEqual(['a']);
    expect(dismissed.map(w => w.id)).toEqual(['b']);
    expect(utils.findOutdatedDismissal(active[0], [{ warningId: 'a', stateHash: 'old' }])).toEqual({
      warningId: 'a',
      stateHash: 'old'
    });
    expect(utils.findOutdatedDismissal(active[0], [{ warningId: 'a', stateHash: '1' }])).toBeNull();
  });

  test('canAcknowledgeModel only for unacknowledged marking gaps', () => {
    expect(utils.canAcknowledgeModel({ issues: ['text-unmarked'], acknowledgement: null })).toBe(
      true
    );
    expect(utils.canAcknowledgeModel({ issues: ['text-unmarked'], acknowledgement: ACK })).toBe(
      false
    );
    expect(utils.canAcknowledgeModel({ issues: [], acknowledgement: null })).toBe(false);
  });

  test('pickBannerWarnings lists errors first and counts the rest', () => {
    const { shown, hiddenCount } = utils.pickBannerWarnings(
      [
        { id: 'w1', severity: 'warning' },
        { id: 'e1', severity: 'error' },
        { id: 'w2', severity: 'warning' },
        { id: 'e2', severity: 'error' }
      ],
      3
    );
    expect(shown.map(w => w.id)).toEqual(['e1', 'e2', 'w1']);
    expect(hiddenCount).toBe(1);
  });

  test('isComplianceBannerUser excludes non-admins, content admins and anonymous', () => {
    expect(utils.isComplianceBannerUser(null)).toBe(false);
    expect(utils.isComplianceBannerUser({ id: 'u', permissions: { contentAdmin: true } })).toBe(
      false
    );
    expect(utils.isComplianceBannerUser({ id: 'anonymous', isAdmin: true })).toBe(false);
    expect(utils.isComplianceBannerUser({ id: 'u', isAdmin: true })).toBe(true);
    expect(utils.isComplianceBannerUser({ id: 'u', permissions: { adminAccess: true } })).toBe(
      true
    );
  });
});

describe('JustificationDialog', () => {
  function renderDialog(props = {}) {
    const onSubmit = props.onSubmit || jest.fn(() => Promise.resolve());
    const onClose = props.onClose || jest.fn();
    render(
      <JustificationDialog
        open
        title="Dismiss warning"
        description="Hides the banner entry only."
        submitLabel="Dismiss warning"
        {...props}
        onSubmit={onSubmit}
        onClose={onClose}
      />
    );
    return { onSubmit, onClose };
  }

  test('is a labelled modal dialog', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Dismiss warning' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Hides the banner entry only.');
  });

  test('submit stays disabled until the trimmed justification has 10 characters', async () => {
    const { onSubmit, onClose } = renderDialog();
    const field = screen.getByLabelText(/Justification/);
    const submit = screen.getByRole('button', { name: 'Dismiss warning' });

    expect(submit).toBeDisabled();
    fireEvent.change(field, { target: { value: '   too short   ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(field, { target: { value: '  Documented known gap  ' } });
    expect(submit).toBeEnabled();

    await act(async () => {
      fireEvent.click(submit);
    });
    expect(onSubmit).toHaveBeenCalledWith('Documented known gap');
    expect(onClose).toHaveBeenCalled();
  });

  test('a failed submit shows the server message and keeps the dialog open', async () => {
    const onSubmit = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('Request failed'), {
          response: { data: { error: 'This warning cannot be dismissed' } }
        })
      )
    );
    const { onClose } = renderDialog({ onSubmit });
    fireEvent.change(screen.getByLabelText(/Justification/), {
      target: { value: 'A sufficiently long reason' }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This warning cannot be dismissed');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('canSubmit=false keeps submit disabled even with a valid justification', () => {
    renderDialog({ canSubmit: false });
    fireEvent.change(screen.getByLabelText(/Justification/), {
      target: { value: 'A sufficiently long reason' }
    });
    expect(screen.getByRole('button', { name: 'Dismiss warning' })).toBeDisabled();
  });

  test('renders nothing while closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ComplianceBanner', () => {
  test('renders nothing and fetches nothing for non-admins', () => {
    mockUser = { id: 'u1', permissions: { contentAdmin: true } };
    const { container } = render(<ComplianceBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(mockApi.fetchComplianceBanner).not.toHaveBeenCalled();
  });

  test('the panel lists warnings in a labelled region and links to the page', async () => {
    mockApi.fetchComplianceBanner.mockResolvedValue({
      conforming: false,
      featureActive: true,
      dismissedCount: 0,
      warnings: [
        {
          id: 'signing:disabled',
          severity: 'error',
          message: 'Signing is disabled',
          dismissible: false
        },
        {
          id: 'model:gpt-x:unmarked',
          severity: 'error',
          message: 'Model "gpt-x" does not mark free-form text',
          dismissible: true
        }
      ]
    });
    render(
      <MemoryRouter>
        <ComplianceBannerPanel />
      </MemoryRouter>
    );
    const region = await screen.findByRole('region', {
      name: /this installation does not conform/
    });
    expect(region).toHaveTextContent('Signing is disabled');
    // Only the dismissible warning offers "Dismiss…".
    expect(screen.getAllByRole('button', { name: /Dismiss/ })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open EU AI Act page' })).toHaveAttribute(
      'href',
      '/admin/eu-ai-act'
    );
  });

  test('the panel renders nothing without active warnings', async () => {
    mockApi.fetchComplianceBanner.mockResolvedValue({
      conforming: true,
      featureActive: true,
      dismissedCount: 2,
      warnings: []
    });
    const { container } = render(
      <MemoryRouter>
        <ComplianceBannerPanel />
      </MemoryRouter>
    );
    await waitFor(() => expect(mockApi.fetchComplianceBanner).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ModelsTab', () => {
  test('an acknowledged unmarked model is still non-conforming', () => {
    render(
      <MemoryRouter>
        <ModelsTab status={makeStatus()} reload={jest.fn()} />
      </MemoryRouter>
    );
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Not marked')).toBeInTheDocument();
    expect(table.getByText('Non-conforming')).toBeInTheDocument();
    expect(table.queryByText('Conforming')).not.toBeInTheDocument();
    expect(table.getByText(/still non-conforming/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Withdraw acknowledgement/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Acknowledge…/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Edit model/ })).toHaveAttribute(
      'href',
      '/admin/models/gpt-x'
    );
  });
});

describe('AdminEuAiActPage', () => {
  function LocationProbe() {
    const location = useLocation();
    return <output data-testid="location">{location.pathname + location.search}</output>;
  }

  function renderPage(initialEntry) {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/admin/eu-ai-act"
            element={
              <>
                <AdminEuAiActPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );
  }

  test('?tab= selects the tab and the header shows the conformance', async () => {
    mockApi.fetchAiTransparencyStatus.mockResolvedValue(makeStatus());
    renderPage('/admin/eu-ai-act?tab=settings');

    expect(await screen.findByText('settings tab stub')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'euaiact-tab-settings');
    expect(screen.getByText('Non-conforming')).toBeInTheDocument();
    expect(screen.getByText('inst_1')).toBeInTheDocument();
  });

  test('arrow keys move to the next tab and update the query', async () => {
    mockApi.fetchAiTransparencyStatus.mockResolvedValue(makeStatus());
    renderPage('/admin/eu-ai-act');

    const overviewTab = await screen.findByRole('tab', { name: /Overview/ });
    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true')
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/eu-ai-act?tab=models');
  });

  test('a failed load shows the error with a retry', async () => {
    mockApi.fetchAiTransparencyStatus.mockRejectedValue(new Error('boom'));
    renderPage('/admin/eu-ai-act');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The EU AI Act status could not be loaded.');
    expect(alert).toHaveTextContent('boom');
  });
});
