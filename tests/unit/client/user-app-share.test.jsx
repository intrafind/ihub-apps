// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sharing a personal app and handing it over, on the editor page
 * (`/apps/:appId/edit`): the share dialog, the offer from the owner's side
 * and the banner the receiver reads.
 *
 * The page, its parts, the share dialog of the prompt library and the shared
 * hand-over dialog are the real ones, with the real texts. Only the API
 * module is a stub, plus the test chat and what the Jest transform cannot
 * load.
 *
 * Slice P8 of concepts/app-builder-rework-2026-11/02-personal-apps.md
 * (sections 11.5, 11.7, 14.3 and 21). "Leave" is an entry of the tile menu on
 * the apps page (slice P6, `user-apps-list.test.jsx`).
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  APP_ID,
  CONFIG,
  EDITOR_PERMISSIONS,
  apiFailure,
  createTexts,
  de,
  en,
  untranslated,
  userApp
} from './helpers/userAppEditorHarness';

const mockApi = Object.fromEntries(
  [
    'acceptUserAppOffer',
    'clearUserAppOffer',
    'deleteUserApp',
    'duplicateUserApp',
    'fetchModels',
    'fetchUserApp',
    'fetchUserAppShareTargets',
    'offerUserApp',
    'setUserAppMembers',
    'updateUserApp',
    'fetchPromptShareTargets',
    'updatePromptShares'
  ].map(name => [name, jest.fn()])
);
jest.mock('../../../client/src/api', () =>
  Object.fromEntries(
    [
      'acceptUserAppOffer',
      'clearUserAppOffer',
      'deleteUserApp',
      'duplicateUserApp',
      'fetchModels',
      'fetchUserApp',
      'fetchUserAppShareTargets',
      'offerUserApp',
      'setUserAppMembers',
      'updateUserApp',
      'fetchPromptShareTargets',
      'updatePromptShares'
    ].map(name => [name, (...args) => mockApi[name](...args)])
  )
);

const mockAdminCalls = [];
jest.mock('../../../client/src/api/adminApi', () => {
  const refuse =
    name =>
    (...args) => {
      mockAdminCalls.push({ name, args });
      return Promise.reject(new Error(`adminApi.${name} was called`));
    };
  return new Proxy(
    { __esModule: true },
    {
      get: (target, name) =>
        name in target || typeof name !== 'string' ? target[name] : refuse(name)
    }
  );
});

const mockUserApps = { config: null, invalidated: 0 };
jest.mock('../../../client/src/shared/hooks/useUserApps', () => ({
  useUserAppsConfig: () => ({ enabled: true, config: mockUserApps.config, loading: false }),
  invalidateUserAppsConfig: () => {
    mockUserApps.invalidated += 1;
  }
}));
jest.mock('../../../client/src/features/admin/components/AppTestPanel', () => ({
  __esModule: true,
  default: ({ appId }) => (
    <aside data-testid="test-panel" data-app={appId}>
      test chat
    </aside>
  )
}));
jest.mock('../../../client/src/pages/error/NotFound', () => ({
  __esModule: true,
  default: () => <div data-testid="not-found">not found</div>
}));

// The installation runs under a base path: the copied link has to carry it.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '/ihub',
  buildPath: p => `/ihub${p}`,
  buildAssetUrl: p => p
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

// One `t` for every render, as react-i18next hands it out: effects depend on it.
const mockTexts = createTexts();
jest.mock('react-i18next', () => ({
  useTranslation: () => mockTexts.translation
}));

const UserAppEditPage = require('../../../client/src/features/apps/pages/UserAppEditPage').default;
const UserAppShareDialog =
  require('../../../client/src/features/apps/components/user-app/UserAppShareDialog').default;
const {
  userAppLink
} = require('../../../client/src/features/apps/components/user-app/UserAppShareDialog');
const {
  membersToShares,
  sharesToMembers
} = require('../../../client/src/features/apps/components/user-app/userAppForm');

const SHARE = en.userApps.share;
const TRANSFER = en.userApps.transfer;

const MEMBERS = [
  { type: 'user', id: 'ben', name: 'Ben Koch', role: 'user' },
  { type: 'group', id: 'hr', name: 'HR', role: 'editor' }
];
const BEN = { id: 'ben', name: 'Ben Koch', email: 'ben@example.org' };

const clipboard = { writeText: jest.fn() };

beforeAll(async () => {
  await mockTexts.init();
  Object.defineProperty(window.navigator, 'clipboard', { value: clipboard, configurable: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminCalls.length = 0;
  mockUserApps.config = CONFIG;
  mockUserApps.invalidated = 0;
  window.localStorage.clear();
  clipboard.writeText.mockResolvedValue(undefined);
  mockApi.fetchUserApp.mockResolvedValue(userApp());
  mockApi.fetchModels.mockResolvedValue([]);
  mockApi.fetchUserAppShareTargets.mockResolvedValue({ users: [], groups: [], everyone: false });
});

let consoleError;
beforeEach(() => {
  consoleError = jest.spyOn(console, 'error');
});
afterEach(() => {
  const unsettled = consoleError.mock.calls.filter(call =>
    String(call[0]).includes('not wrapped in act')
  );
  consoleError.mockRestore();
  expect(unsettled).toEqual([]);
  expect(mockAdminCalls).toEqual([]);
});

function Where({ label }) {
  const location = useLocation();
  return (
    <div data-testid="where">
      {label}:{location.pathname}
      {location.search}
    </div>
  );
}

async function renderEditor(entry = `/apps/${APP_ID}/edit`) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/apps" element={<Where label="LIST" />} />
          <Route
            path="/apps/:appId/edit"
            element={
              <>
                <UserAppEditPage />
                <Where label="EDITOR" />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );
  });
}

async function click(element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** Types into the search box of a dialog and waits for the debounced lookup to answer. */
async function search(dialog, text) {
  const box = within(dialog).queryByRole('searchbox') || within(dialog).getByRole('textbox');
  const before = mockApi.fetchUserAppShareTargets.mock.calls.length;
  await act(async () => {
    fireEvent.change(box, { target: { value: text } });
  });
  await waitFor(() =>
    expect(mockApi.fetchUserAppShareTargets.mock.calls.length).toBeGreaterThan(before)
  );
  // The lookup's answer.
  await act(async () => {});
}

async function openMenuItem(name) {
  await click(screen.getByRole('button', { name: 'More' }));
  await click(screen.getByRole('menuitem', { name }));
}

describe('members and shares', () => {
  test('a member is a share and back, with the role kept', () => {
    const everyone = { type: 'everyone', id: null, name: '', role: 'user' };
    expect(membersToShares([...MEMBERS, everyone])).toEqual([
      { type: 'user', id: 'ben', name: 'Ben Koch', permission: 'use' },
      { type: 'group', id: 'hr', name: 'HR', permission: 'edit' },
      { type: 'everyone', id: null, permission: 'use' }
    ]);
    // The body of PUT …/members: no names, and "everyone" without an ID.
    expect(sharesToMembers(membersToShares([...MEMBERS, everyone]))).toEqual([
      { type: 'user', id: 'ben', role: 'user' },
      { type: 'group', id: 'hr', role: 'editor' },
      { type: 'everyone', role: 'user' }
    ]);
    expect(membersToShares(undefined)).toEqual([]);
  });
});

describe('the share dialog', () => {
  async function renderDialog(app, handlers = {}) {
    await act(async () => {
      render(
        <UserAppShareDialog
          app={app}
          name="Job ad writer"
          onClose={handlers.onClose || (() => {})}
          onSaved={handlers.onSaved || (() => {})}
        />
      );
    });
    // The dialog asks for the targets right after it opened; until the answer
    // is there it does not know which audiences the settings allow.
    await waitFor(() => expect(mockApi.fetchUserAppShareTargets).toHaveBeenCalled());
    await act(async () => {});
    return screen.getByRole('dialog');
  }

  test('lists the members with their roles and says what sharing means', async () => {
    const dialog = await renderDialog(userApp({ members: MEMBERS }));
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Share "Job ad writer"');
    const rows = within(dialog)
      .getAllByRole('combobox')
      .map(select => [select.closest('li').textContent.includes('Ben Koch'), select.value]);
    expect(rows).toEqual([
      [true, 'use'],
      [false, 'edit']
    ]);
    expect(within(dialog).getByText(SHARE.help)).toBeInTheDocument();
    expect(untranslated(dialog)).toEqual([]);
    expect(mockApi.fetchUserAppShareTargets).toHaveBeenCalledWith({ q: '' });
  });

  test('an app that is not shared says so', async () => {
    const dialog = await renderDialog(userApp());
    expect(within(dialog).getByText(SHARE.private)).toBeInTheDocument();
  });

  test('saves the members with their roles', async () => {
    mockApi.fetchUserAppShareTargets.mockResolvedValue({
      users: [BEN],
      groups: [{ id: 'hr', name: 'HR', description: '' }],
      everyone: false
    });
    const onSaved = jest.fn();
    const dialog = await renderDialog(userApp(), { onSaved });
    await search(dialog, 'be');
    expect(mockApi.fetchUserAppShareTargets).toHaveBeenLastCalledWith({ q: 'be' });
    await click(within(dialog).getByRole('button', { name: /Ben Koch/ }));
    await search(dialog, 'hr');
    await click(within(dialog).getByRole('button', { name: /HR/ }));
    const [, hrRole] = within(dialog).getAllByRole('combobox');
    await act(async () => {
      fireEvent.change(hrRole, { target: { value: 'edit' } });
    });

    const saved = userApp({ members: MEMBERS, revision: 8 });
    mockApi.setUserAppMembers.mockResolvedValue(saved);
    await click(within(dialog).getByRole('button', { name: 'Save' }));
    // On the revision the dialog was opened with (sent as `If-Match: "7"`).
    expect(mockApi.setUserAppMembers).toHaveBeenCalledWith(
      APP_ID,
      [
        { type: 'user', id: 'ben', role: 'user' },
        { type: 'group', id: 'hr', role: 'editor' }
      ],
      { revision: 7 }
    );
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  test('"everyone" is offered only when the settings allow it', async () => {
    const dialog = await renderDialog(userApp());
    expect(
      within(dialog).queryByRole('button', { name: en.prompts.share.addEveryone })
    ).not.toBeInTheDocument();
  });

  test('without users and groups to share with there is no search box', async () => {
    mockApi.fetchUserAppShareTargets.mockResolvedValue({
      users: [],
      groups: [],
      everyone: true,
      allowed: { user: false, group: false, everyone: true }
    });
    const dialog = await renderDialog(userApp());
    await waitFor(() => expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument());
    expect(
      within(dialog).getByRole('button', { name: en.prompts.share.addEveryone })
    ).toBeInTheDocument();
  });

  test('too many open offers: the sentence names the limit the server sent', () => {
    const {
      userAppErrorMessage
    } = require('../../../client/src/features/apps/components/user-app/userAppErrors');
    const t = (key, options) => mockTexts.instance.t(key, options);
    const refused = max =>
      apiFailure(409, { code: 'QUOTA_USER_APP_OFFERS', ...(max ? { details: { max } } : {}) });
    expect(userAppErrorMessage(refused(5), t)).toBe('You have 5 open offers. Withdraw one first.');
    expect(userAppErrorMessage(refused(), t)).toBe(en.apiErrors.QUOTA_USER_APP_OFFERS);
  });

  test('the roles and "everyone" carry the words of personal apps, in German too', async () => {
    await act(async () => {
      await mockTexts.instance.changeLanguage('de');
    });
    try {
      const everyone = { type: 'everyone', id: null, name: '', role: 'user' };
      const dialog = await renderDialog(userApp({ members: [MEMBERS[0], everyone] }));
      const [role] = within(dialog).getAllByRole('combobox');
      expect(
        within(role)
          .getAllByRole('option')
          .map(option => option.textContent)
      ).toEqual(['Kann nutzen', 'Kann bearbeiten']);
      expect(within(dialog).getByText('Alle angemeldeten Benutzer')).toBeInTheDocument();
    } finally {
      await act(async () => {
        await mockTexts.instance.changeLanguage('en');
      });
    }
  });

  test('"everyone" can be added where the settings allow it', async () => {
    mockApi.fetchUserAppShareTargets.mockResolvedValue({ users: [], groups: [], everyone: true });
    const dialog = await renderDialog(userApp());
    await click(within(dialog).getByRole('button', { name: en.prompts.share.addEveryone }));
    mockApi.setUserAppMembers.mockResolvedValue(userApp());
    await click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(mockApi.setUserAppMembers).toHaveBeenCalledWith(
      APP_ID,
      [{ type: 'everyone', role: 'user' }],
      { revision: 7 }
    );
  });

  test('"Copy link" copies the address of the chat under the base path', async () => {
    const dialog = await renderDialog(userApp());
    expect(within(dialog).queryByText(SHARE.linkCopied)).not.toBeInTheDocument();
    await click(within(dialog).getByRole('button', { name: SHARE.copyLink }));
    expect(clipboard.writeText).toHaveBeenCalledWith(`http://localhost/ihub/apps/${APP_ID}`);
    expect(userAppLink(APP_ID)).toBe(`http://localhost/ihub/apps/${APP_ID}`);
    expect(within(dialog).getByText(SHARE.linkCopied)).toBeInTheDocument();
    // Copying shares nothing.
    expect(mockApi.setUserAppMembers).not.toHaveBeenCalled();
  });

  test('a refused save is shown in the dialog, and the list stays', async () => {
    const dialog = await renderDialog(userApp({ members: MEMBERS }));
    mockApi.setUserAppMembers.mockRejectedValue(
      apiFailure(403, { code: 'SHARE_TARGET_NOT_ALLOWED', detail: 'Groups are not allowed' })
    );
    await click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(2);
  });

  test('a share refused because the owner may not share says so', async () => {
    const dialog = await renderDialog(userApp({ members: MEMBERS }));
    mockApi.setUserAppMembers.mockRejectedValue(
      apiFailure(403, {
        code: 'PERMISSION_DENIED',
        details: { required: 'userAppSharing', reason: 'ownerMayNotShare' }
      })
    );
    await click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      en.userApps.denied.ownerMayNotShare
    );
  });

  test('a share refused without a known reason gets the neutral text of its code', async () => {
    const dialog = await renderDialog(userApp({ members: MEMBERS }));
    mockApi.setUserAppMembers.mockRejectedValue(
      apiFailure(403, { code: 'PERMISSION_DENIED', details: { required: 'view' } })
    );
    await click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(en.apiErrors.PERMISSION_DENIED);
  });
});

describe('sharing from the editor', () => {
  test('"Share" opens the dialog; saving updates the chip and keeps unsaved input', async () => {
    await renderEditor();
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: /^Name/ }), {
        target: { value: 'Unsaved name' }
      });
    });
    await click(screen.getByRole('button', { name: 'Share' }));
    const dialog = screen.getByRole('dialog');
    mockApi.setUserAppMembers.mockResolvedValue(
      userApp({
        members: MEMBERS,
        sharedWith: { users: 1, groups: 1, everyone: false },
        revision: 8
      })
    );
    await click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-app-state')).toHaveTextContent('Shared with 1 person, 1 group');
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Unsaved name');

    // The save that follows names the revision the member change produced.
    mockApi.updateUserApp.mockResolvedValue(userApp({ revision: 9 }));
    await click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(mockApi.updateUserApp).toHaveBeenCalledWith(
      APP_ID,
      { name: { en: 'Unsaved name' } },
      { revision: 8 }
    );
  });

  test('the dialog is named by its title (WCAG 4.1.2)', async () => {
    await renderEditor();
    await click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByRole('dialog', { name: 'Share "Job ad writer"' })).toBeInTheDocument();
  });

  test('a change by someone else reloads the app; saving again carries the new revision', async () => {
    await renderEditor();
    await click(screen.getByRole('button', { name: 'Share' }));
    const dialog = screen.getByRole('dialog');
    mockApi.setUserAppMembers.mockRejectedValueOnce(
      apiFailure(409, { code: 'ETAG_MISMATCH', detail: 'The data was changed' })
    );
    mockApi.fetchUserApp.mockResolvedValue(userApp({ revision: 8 }));
    await click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(SHARE.changed);
    await waitFor(() => expect(mockApi.fetchUserApp).toHaveBeenCalledTimes(2));

    mockApi.setUserAppMembers.mockResolvedValue(userApp({ revision: 9 }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    expect(mockApi.setUserAppMembers).toHaveBeenLastCalledWith(APP_ID, [], { revision: 8 });
  });

  test('the apps page opens the dialog with ?dialog=share', async () => {
    await renderEditor(`/apps/${APP_ID}/edit?dialog=share`);
    expect(screen.getByRole('dialog')).toHaveTextContent('Share "Job ad writer"');
    expect(screen.getByTestId('where')).toHaveTextContent(`EDITOR:/apps/${APP_ID}/edit`);
    expect(screen.getByTestId('where')).not.toHaveTextContent('dialog');
  });

  test('without the permission there is no "Share", and the link says why', async () => {
    mockApi.fetchUserApp.mockResolvedValue(userApp({ permissions: { canShare: false } }));
    await renderEditor(`/apps/${APP_ID}/edit?dialog=share`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    expect(screen.getByText(SHARE.notAllowed)).toBeInTheDocument();
    expect(screen.getByTestId('user-app-state')).toHaveTextContent(en.userApps.edit.state.private);
  });
});

describe('handing over: the owner', () => {
  test('pick, read what it means, ask; nothing is sent before the confirmation', async () => {
    mockApi.fetchUserAppShareTargets.mockResolvedValue({
      users: [BEN],
      groups: [],
      everyone: false
    });
    await renderEditor();
    await openMenuItem(TRANSFER.action);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent(TRANSFER.action);
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled();

    await search(dialog, 'ben');
    // The lookup of an offer answers users only, whatever the sharing settings say.
    expect(mockApi.fetchUserAppShareTargets).toHaveBeenLastCalledWith({
      q: 'ben',
      purpose: 'offer'
    });
    await click(within(dialog).getByRole('button', { name: /Ben Koch/ }));
    await click(within(dialog).getByRole('button', { name: 'Next' }));

    expect(within(dialog).getByRole('heading')).toHaveTextContent(
      'Hand over "Job ad writer" to Ben Koch?'
    );
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual([
      'Ben Koch is asked to take the app over. Until Ben Koch accepts, you stay the owner and nothing changes.',
      'After that, Ben Koch can change, share and delete the app. Everyone with "Can edit" gets "Can use".',
      'You keep no access unless Ben Koch shares it with you.'
    ]);
    expect(untranslated(dialog)).toEqual([]);
    expect(mockApi.offerUserApp).not.toHaveBeenCalled();

    mockApi.offerUserApp.mockResolvedValue(
      userApp({ pendingOwner: { id: 'ben', name: 'Ben Koch', offeredAt: 'x' }, revision: 8 })
    );
    await click(within(dialog).getByRole('button', { name: 'Ask Ben Koch' }));
    expect(mockApi.offerUserApp).toHaveBeenCalledWith(APP_ID, 'ben');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The owner stays the owner; the chip says the app is offered.
    expect(screen.getByTestId('user-app-state')).toHaveTextContent('Offered to Ben Koch');
    expect(screen.getByRole('button', { name: TRANSFER.withdraw })).toBeInTheDocument();
  });

  test('too many open offers is said in the dialog', async () => {
    mockApi.fetchUserAppShareTargets.mockResolvedValue({
      users: [BEN],
      groups: [],
      everyone: false
    });
    await renderEditor();
    await openMenuItem(TRANSFER.action);
    const dialog = screen.getByRole('dialog');
    await search(dialog, 'ben');
    await click(within(dialog).getByRole('button', { name: /Ben Koch/ }));
    await click(within(dialog).getByRole('button', { name: 'Next' }));
    mockApi.offerUserApp.mockRejectedValue(
      apiFailure(409, {
        code: 'QUOTA_USER_APP_OFFERS',
        detail: 'The limit of open offers is reached'
      })
    );
    await click(within(dialog).getByRole('button', { name: 'Ask Ben Koch' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(en.apiErrors.QUOTA_USER_APP_OFFERS);
  });

  test('"Withdraw" removes the offer and reads the app again', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({ pendingOwner: { id: 'ben', name: 'Ben Koch', offeredAt: 'x' } })
    );
    await renderEditor();
    expect(screen.getByTestId('user-app-state')).toHaveTextContent('Offered to Ben Koch');
    mockApi.clearUserAppOffer.mockResolvedValue(undefined);
    mockApi.fetchUserApp.mockResolvedValue(userApp({ revision: 8 }));
    await click(screen.getByRole('button', { name: TRANSFER.withdraw }));
    expect(mockApi.clearUserAppOffer).toHaveBeenCalledWith(APP_ID);
    expect(screen.getByTestId('user-app-state')).toHaveTextContent(en.userApps.edit.state.private);
    expect(screen.queryByRole('button', { name: TRANSFER.withdraw })).not.toBeInTheDocument();
  });

  test('an editor is offered neither "Hand over" nor "Withdraw"', async () => {
    mockApi.fetchUserApp.mockResolvedValue(userApp({ permissions: EDITOR_PERMISSIONS }));
    await renderEditor();
    await click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: TRANSFER.action })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TRANSFER.withdraw })).not.toBeInTheDocument();
  });
});

describe('handing over: the receiver', () => {
  const OFFERED = {
    canEdit: false,
    canShare: false,
    canDelete: false,
    canOffer: false,
    canAcceptOffer: true,
    isOwner: false,
    role: 'offered'
  };
  const offeredApp = (changes = {}) =>
    userApp({
      permissions: OFFERED,
      pendingOwner: {
        id: 'carla',
        name: 'Carla Diaz',
        offeredAt: '2026-11-20T10:00:00Z',
        offeredBy: { id: 'anna', name: 'Anna Schmidt' }
      },
      members: [
        ...MEMBERS,
        { type: 'user', id: 'dora', name: 'Dora Ek', role: 'user' },
        { type: 'everyone', id: null, name: '', role: 'user' }
      ],
      ...changes
    });
  const banner = () => within(screen.getByTestId('user-app-offer'));

  test('reads the app read-only, with who offers it and who it is shared with', async () => {
    mockApi.fetchUserApp.mockResolvedValue(offeredApp());
    await renderEditor();
    expect(
      banner().getByText('Anna Schmidt wants to hand this app over to you.')
    ).toBeInTheDocument();
    expect(banner().getByText(TRANSFER.receivedDuty)).toBeInTheDocument();
    expect(screen.getByTestId('user-app-offer-members')).toHaveTextContent(
      'It is shared with: Ben Koch (can use), HR (can edit), 2 more…'
    );
    expect(banner().getByText(TRANSFER.receivedEditors)).toBeInTheDocument();
    // The instructions are there to be read, and cannot be changed.
    expect(screen.queryByRole('textbox', { name: /^Instructions/ })).not.toBeInTheDocument();
    const instructions = screen.getByTestId('read-only-system');
    expect(instructions).toHaveTextContent('You write job ads from notes.');
    // Keyboard users can reach and scroll long instructions (WCAG 2.1.1).
    expect(instructions).toHaveAttribute('tabindex', '0');
    expect(screen.queryByTestId('user-app-status')).not.toBeInTheDocument();
    expect(untranslated(document.body)).toEqual([]);

    await click(banner().getByRole('button', { name: 'Show all' }));
    expect(screen.getByTestId('user-app-offer-members')).toHaveTextContent(
      'It is shared with: Ben Koch (can use), HR (can edit), Dora Ek (can use), Everyone signed in (can use)'
    );
    expect(banner().queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
  });

  test('a receiver the app is already shared with ("Can edit") sees the offer and keeps editing', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      offeredApp({ permissions: { ...EDITOR_PERMISSIONS, canAcceptOffer: true } })
    );
    await renderEditor();
    expect(
      banner().getByText('Anna Schmidt wants to hand this app over to you.')
    ).toBeInTheDocument();
    expect(banner().getByRole('button', { name: TRANSFER.accept })).toBeInTheDocument();
    // The share still lets them change the app.
    expect(screen.getByRole('textbox', { name: /^Instructions/ })).toBeEnabled();
  });

  test('without editors the line about "Can edit" is left out', async () => {
    mockApi.fetchUserApp.mockResolvedValue(offeredApp({ members: [MEMBERS[0]] }));
    await renderEditor();
    expect(screen.getByTestId('user-app-offer-members')).toHaveTextContent(
      'It is shared with: Ben Koch (can use)'
    );
    expect(banner().queryByText(TRANSFER.receivedEditors)).not.toBeInTheDocument();
  });

  test('"Try it" opens the chat of the app beside the page', async () => {
    mockApi.fetchUserApp.mockResolvedValue(offeredApp());
    await renderEditor();
    await click(banner().getByRole('button', { name: TRANSFER.try }));
    expect(screen.getByTestId('test-panel')).toHaveAttribute('data-app', APP_ID);
  });

  test('"Take over" sends the revision the page loaded; the receiver then owns the app', async () => {
    mockApi.fetchUserApp.mockResolvedValue(offeredApp());
    await renderEditor();
    mockApi.acceptUserAppOffer.mockResolvedValue(
      userApp({ owner: { id: 'carla', name: 'Carla Diaz', active: true }, revision: 8 })
    );
    await click(banner().getByRole('button', { name: TRANSFER.accept }));
    // The API module sends `revision` as `If-Match: "7"`.
    expect(mockApi.acceptUserAppOffer).toHaveBeenCalledWith(APP_ID, { revision: 7 });
    expect(screen.queryByTestId('user-app-offer')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Instructions/ })).toBeEnabled();
    expect(mockUserApps.invalidated).toBe(1);
  });

  test('409 ETAG_MISMATCH reloads the app and asks to read it again', async () => {
    mockApi.fetchUserApp.mockResolvedValue(offeredApp());
    await renderEditor();
    mockApi.acceptUserAppOffer.mockRejectedValue(
      apiFailure(409, { code: 'ETAG_MISMATCH', detail: 'The app was changed by someone else' })
    );
    mockApi.fetchUserApp.mockResolvedValue(
      offeredApp({ system: { en: 'You write job ads. Always mention the salary.' }, revision: 8 })
    );
    await click(banner().getByRole('button', { name: TRANSFER.accept }));

    expect(mockApi.fetchUserApp).toHaveBeenCalledTimes(2);
    expect(banner().getByText(TRANSFER.changed)).toBeInTheDocument();
    expect(screen.getByTestId('read-only-system')).toHaveTextContent(
      'You write job ads. Always mention the salary.'
    );
    // The app is still offered, and the next answer names the new revision.
    mockApi.acceptUserAppOffer.mockResolvedValue(userApp({ revision: 9 }));
    await click(banner().getByRole('button', { name: TRANSFER.accept }));
    expect(mockApi.acceptUserAppOffer).toHaveBeenLastCalledWith(APP_ID, { revision: 8 });
  });

  test('a refusal is said on the page (the limit of the receiver)', async () => {
    mockApi.fetchUserApp.mockResolvedValue(offeredApp());
    await renderEditor();
    mockApi.acceptUserAppOffer.mockRejectedValue(
      apiFailure(409, { code: 'QUOTA_USER_APPS', detail: 'The limit of personal apps is reached' })
    );
    await click(banner().getByRole('button', { name: TRANSFER.accept }));
    expect(screen.getByRole('alert')).toHaveTextContent(en.apiErrors.QUOTA_USER_APPS);
    expect(screen.getByTestId('user-app-offer')).toBeInTheDocument();
  });

  test('"Decline" removes the offer and leads to the apps page', async () => {
    mockApi.fetchUserApp.mockResolvedValue(offeredApp());
    await renderEditor();
    mockApi.clearUserAppOffer.mockResolvedValue(undefined);
    await click(banner().getByRole('button', { name: TRANSFER.decline }));
    expect(mockApi.clearUserAppOffer).toHaveBeenCalledWith(APP_ID);
    expect(mockApi.acceptUserAppOffer).not.toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('LIST:/apps');
  });
});

describe('the texts of sharing and handing over', () => {
  test('German says "Benutzer" and uses the formal address', () => {
    expect(de.userApps.share.everyone).toBe('Alle angemeldeten Benutzer');
    expect(de.userApps.transfer.line1).toContain('bleiben Sie Besitzer');
  });
});
