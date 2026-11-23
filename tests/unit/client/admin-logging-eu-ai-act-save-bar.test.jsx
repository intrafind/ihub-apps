// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One bottom save bar for the pages with several independently saved sections: the Logging
 * page (logging, authentication debug, privacy) and the EU AI Act cards (AI notice, AI
 * acknowledgement, provenance settings).
 *
 * The bar shows only once something changed (also a change nested inside a block), one Save
 * writes the changed sections in page order and stops at the first failure, Discard puts
 * every section back, and the provenance confirmation still asks before it saves.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockAdminCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...a) => mockAdminCall(...a),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const template = typeof fallback === 'string' ? fallback : key;
      const vars = (typeof fallback === 'object' ? fallback : options) || {};
      return template.replace(/\{\{(\w+)\}\}/g, (m, name) =>
        name in vars ? String(vars[name]) : m
      );
    },
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: {}, refreshConfig: jest.fn() })
}));
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useAiAcknowledgementAdmin', () => ({
  __esModule: true,
  useAiAcknowledgementAdmin: () => ({ reload: jest.fn(), settings: { requiredVersion: 1 } })
}));
jest.mock('../../../client/src/features/admin/components/euAiAct/EuAiActStateNote', () => ({
  __esModule: true,
  default: () => null
}));

const AdminLoggingPage =
  require('../../../client/src/features/admin/pages/AdminLoggingPage').default;
const AiNoticeSettingsCard =
  require('../../../client/src/features/admin/components/AiNoticeSettingsCard').default;
const AiAcknowledgementSettingsCard =
  require('../../../client/src/features/admin/components/AiAcknowledgementSettingsCard').default;
const ProvenanceSettingsCard =
  require('../../../client/src/features/admin/components/euAiAct/ProvenanceSettingsCard').default;
const {
  SaveSectionsBar,
  SaveSectionsProvider
} = require('../../../client/src/features/admin/components/SaveSections');

const bar = () => screen.queryByRole('region', { name: /save changes/i });
const barButton = name =>
  within(screen.getByRole('region', { name: /save changes/i })).getByRole('button', { name });
const save = () => fireEvent.click(barButton('Save Changes'));
const discard = () => fireEvent.click(barButton('Discard'));

/** The page captures its saved baseline a moment after the load; an edit before that would count as loaded. */
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
  });

const calls = (url, method) =>
  mockAdminCall.mock.calls.filter(([u, o]) => u === url && (o?.method || 'GET') === method);
const writes = () =>
  mockAdminCall.mock.calls
    .filter(([, o]) => o?.method && o.method !== 'GET')
    .map(([url, o]) => [o.method, url, o.body]);

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  mockAdminCall.mockReset();
});

describe('Logging page', () => {
  let failPlatform;

  beforeEach(() => {
    failPlatform = false;
    mockAdminCall.mockImplementation(async (url, options = {}) => {
      const method = options.method || 'GET';
      if (method === 'PATCH' && url === '/admin/configs/platform' && failPlatform) {
        throw new Error('platform write refused');
      }
      if (method !== 'GET') return { data: {} };
      if (url === '/admin/logging/config') {
        return { data: { level: 'info', format: 'json', anonymizeIp: 'off' } };
      }
      if (url === '/admin/configs/platform')
        return { data: { auth: { debug: { enabled: false } } } };
      if (url === '/admin/audit-log/settings') return { data: { anonymizeIp: 'off' } };
      return { data: {} };
    });
  });

  const open = async () => {
    render(<AdminLoggingPage />);
    await screen.findByLabelText('Enable authentication debug logging');
    await settle();
  };

  test('there is no Save button of its own, and no bar until something changed', async () => {
    await open();
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save .*(Configuration|Settings)$/ })).toBeNull();
  });

  test('a change nested inside a block (file logging enabled) shows the bar; Discard puts it back', async () => {
    await open();
    const toggle = () => screen.getByLabelText('Enable file logging');
    expect(toggle()).not.toBeChecked();

    fireEvent.click(toggle());
    expect(toggle()).toBeChecked();
    expect(bar()).toBeInTheDocument();

    discard();
    expect(toggle()).not.toBeChecked();
    expect(bar()).not.toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  test('one Save writes the changed blocks in page order: logging, authentication debug, privacy', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /^debug/i }));
    fireEvent.click(screen.getByLabelText('Enable authentication debug logging'));
    fireEvent.change(screen.getByLabelText('Anonymize IP in structured logs'), {
      target: { value: 'mask' }
    });

    save();
    await waitFor(() => expect(calls('/admin/audit-log/settings', 'PUT')).toHaveLength(1));

    const sequence = writes().map(([method, url]) => `${method} ${url}`);
    expect(sequence).toEqual([
      'PUT /admin/logging/config',
      'PATCH /admin/configs/platform',
      'PUT /admin/logging/config',
      'PUT /admin/audit-log/settings'
    ]);
    const [logging, debug, privacy] = writes();
    expect(logging[2].level).toBe('debug');
    expect(debug[2].auth.debug.enabled).toBe(true);
    expect(privacy[2]).toEqual({ anonymizeIp: 'mask' });
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  test('an untouched block is not written: only the changed one is', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('Enable authentication debug logging'));

    save();
    await waitFor(() => expect(calls('/admin/configs/platform', 'PATCH')).toHaveLength(1));
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
    expect(writes().map(([method, url]) => `${method} ${url}`)).toEqual([
      'PATCH /admin/configs/platform'
    ]);
  });

  test('a failed block stops the save, the bar names the error, and a retry writes only what is left', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /^debug/i }));
    fireEvent.click(screen.getByLabelText('Enable authentication debug logging'));
    fireEvent.change(screen.getByLabelText('Anonymize IP in structured logs'), {
      target: { value: 'mask' }
    });
    failPlatform = true;

    save();
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: /save changes/i })).getByText(
          /platform write refused/
        )
      ).toBeInTheDocument()
    );
    // Logging was saved, authentication debug failed, privacy never ran.
    expect(writes().map(([method, url]) => `${method} ${url}`)).toEqual([
      'PUT /admin/logging/config',
      'PATCH /admin/configs/platform'
    ]);
    expect(bar()).toBeInTheDocument();

    failPlatform = false;
    await waitFor(() => expect(barButton('Save Changes')).toBeEnabled());
    save();
    await waitFor(() => expect(calls('/admin/audit-log/settings', 'PUT')).toHaveLength(1));
    expect(writes().map(([method, url]) => `${method} ${url}`)).toEqual([
      'PUT /admin/logging/config',
      'PATCH /admin/configs/platform',
      'PATCH /admin/configs/platform',
      'PUT /admin/logging/config',
      'PUT /admin/audit-log/settings'
    ]);
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });
});

describe('EU AI Act cards', () => {
  let platform;
  let failPatchOf;

  beforeEach(() => {
    failPatchOf = null;
    platform = {
      chats: { enabled: true },
      aiDisclosure: { firstTurnNotice: { enabled: true, text: {} } },
      aiAcknowledgement: { enabled: true, enforce: true, text: {}, policyUrl: '/policy' },
      provenance: {
        retentionDays: 365,
        storeRecords: true,
        verify: { access: 'authenticated' },
        media: { maxVerifyBytes: 52428800, readC2pa: true },
        watermark: { minScoredTokens: 300 }
      }
    };
    mockAdminCall.mockImplementation(async (url, options = {}) => {
      if (options.method === 'PATCH') {
        const [block] = Object.keys(options.body);
        if (failPatchOf === block) throw new Error(`${block} refused`);
        platform = { ...platform, ...options.body };
        return { data: structuredClone(platform) };
      }
      return { data: structuredClone(platform) };
    });
  });

  const open = async () => {
    render(
      <SaveSectionsProvider>
        <AiNoticeSettingsCard />
        <AiAcknowledgementSettingsCard />
        <ProvenanceSettingsCard />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    await screen.findByLabelText(/Keep records for/);
    await screen.findByLabelText('Show an AI notice before the first message');
    await screen.findByLabelText('AI policy link (https://… or /path)');
    await settle();
  };
  const patches = () =>
    mockAdminCall.mock.calls
      .filter(([, o]) => o?.method === 'PATCH')
      .map(([, o]) => Object.keys(o.body)[0]);

  test('the cards have no Save button of their own, and no bar until something changed', async () => {
    await open();
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
  });

  test('a nested edit (the notice switch, the policy link) shows the bar; Discard restores both cards', async () => {
    await open();
    const notice = () => screen.getByLabelText('Show an AI notice before the first message');
    const policy = () => screen.getByLabelText('AI policy link (https://… or /path)');

    fireEvent.click(notice());
    expect(bar()).toBeInTheDocument();
    fireEvent.change(policy(), { target: { value: '/other' } });
    fireEvent.change(screen.getByLabelText(/Keep records for/), { target: { value: '400' } });

    discard();
    expect(notice()).toBeChecked();
    expect(policy()).toHaveValue('/policy');
    expect(screen.getByLabelText(/Keep records for/)).toHaveValue(365);
    expect(bar()).not.toBeInTheDocument();
    expect(patches()).toEqual([]);
  });

  test('one Save writes the AI notice, the acknowledgement and the provenance block, in page order', async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/Keep records for/), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('AI policy link (https://… or /path)'), {
      target: { value: '/other' }
    });
    fireEvent.click(screen.getByLabelText('Show an AI notice before the first message'));

    save();
    await waitFor(() => expect(patches()).toHaveLength(3));
    expect(patches()).toEqual(['aiDisclosure', 'aiAcknowledgement', 'provenance']);
    const bodyOf = block =>
      mockAdminCall.mock.calls.find(([, o]) => o?.method === 'PATCH' && o.body[block])[1].body[
        block
      ];
    expect(bodyOf('aiDisclosure').firstTurnNotice.enabled).toBe(false);
    expect(bodyOf('aiAcknowledgement').policyUrl).toBe('/other');
    expect(bodyOf('provenance').retentionDays).toBe(400);
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  test('a failed card stops the save and names the error; the cards after it stay unsaved', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('Show an AI notice before the first message'));
    fireEvent.change(screen.getByLabelText(/Keep records for/), { target: { value: '400' } });
    failPatchOf = 'aiDisclosure';

    save();
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: /save changes/i })).getByText(
          /aiDisclosure refused/
        )
      ).toBeInTheDocument()
    );
    expect(patches()).toEqual(['aiDisclosure']);

    failPatchOf = null;
    await waitFor(() => expect(barButton('Save Changes')).toBeEnabled());
    save();
    await waitFor(() => expect(patches()).toHaveLength(3));
    expect(patches()).toEqual(['aiDisclosure', 'aiDisclosure', 'provenance']);
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  test('invalid provenance input: nothing is sent and the bar says what to fix', async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/Keep records for/), { target: { value: '-3' } });

    save();
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: /save changes/i })).getByText(
          /Fix the marked fields/
        )
      ).toBeInTheDocument()
    );
    expect(patches()).toEqual([]);
    expect(screen.getByLabelText(/Keep records for/)).toHaveAttribute('aria-invalid', 'true');
  });

  test('lowering the retention still asks: the bar waits for the answer, Cancel saves nothing, Save writes', async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/Keep records for/), { target: { value: '30' } });

    save();
    const dialog = (await screen.findByText('Save these settings?')).closest(
      '[role="alertdialog"]'
    );
    expect(patches()).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(patches()).toEqual([]);
    expect(bar()).toBeInTheDocument();
    await waitFor(() => expect(barButton('Save Changes')).toBeEnabled());

    save();
    const again = (await screen.findByText('Save these settings?')).closest('[role="alertdialog"]');
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toEqual(['provenance']));
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  test('a later section waits for the confirmation of an earlier one', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('Show an AI notice before the first message'));
    fireEvent.change(screen.getByLabelText(/Keep records for/), { target: { value: '30' } });

    save();
    await waitFor(() => expect(patches()).toEqual(['aiDisclosure']));
    const dialog = (await screen.findByText('Save these settings?')).closest(
      '[role="alertdialog"]'
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toEqual(['aiDisclosure', 'provenance']));
  });

  test('Enter in a provenance field saves the card, as the bar does', async () => {
    await open();
    const retention = screen.getByLabelText(/Keep records for/);
    fireEvent.change(retention, { target: { value: '400' } });

    fireEvent.submit(retention.closest('form'));
    await waitFor(() => expect(patches()).toEqual(['provenance']));
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });
});
