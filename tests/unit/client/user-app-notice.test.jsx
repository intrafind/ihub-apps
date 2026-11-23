// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import en from '../../../shared/i18n/en.json';

/**
 * The chat of a personal app someone else owns (concept 02-personal-apps,
 * 11.8): one case per line of the notice, built from `owner`, `capabilities`
 * and `approval` of the server's answer; the page shown instead of the chat
 * when the app cannot be used; and the approval card, which offers "allow
 * for this chat" only when the event allows it.
 *
 * The texts are the English texts of `shared/i18n/en.json`. The words for a
 * capability inside a sentence (`userApps.notice.capability.*`) and the two
 * collapse labels are reported to the owner of the locale files; until they
 * are there, they read as their key.
 */

const mockApi = { fetchAppDetails: jest.fn() };
jest.mock('../../../client/src/api', () => ({
  fetchAppDetails: (...args) => mockApi.fetchAppDetails(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/pages/AppChat', () => ({
  __esModule: true,
  default: ({ preloadedApp }) => <div data-testid="chat">{preloadedApp.id}</div>
}));
jest.mock('../../../client/src/features/apps/pages/RedirectApp', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/pages/IframeApp', () => ({
  __esModule: true,
  default: () => null
}));

const mockLocale = { en };
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const found = key.split('.').reduce((node, part) => node?.[part], mockLocale.en);
  const fallback =
    typeof defaultOrOptions === 'string' ? defaultOrOptions : options.defaultValue || key;
  const text = typeof found === 'string' ? found : fallback;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const PersonalAppNoticeModule = require('../../../client/src/features/apps/components/PersonalAppNotice');
const PersonalAppNotice = PersonalAppNoticeModule.default;
const { personalAppNoticeLines, showsPersonalAppNotice, PersonalAppUnavailable } =
  PersonalAppNoticeModule;
const AppRouterWrapper =
  require('../../../client/src/features/apps/components/AppRouterWrapper').default;
const ApprovalCard = require('../../../client/src/features/chat/components/ApprovalCard').default;
const { buildToolApproval } = require('../../../client/src/features/chat/runToMessage');

const APP_ID = `uap_${'a'.repeat(32)}`;
const member = (extra = {}) => ({
  id: APP_ID,
  ownership: 'user',
  name: { de: 'Reply to a customer' },
  system: { de: 'Answer friendly and short.\n<b>never markup</b>' },
  owner: { id: 'anna', name: 'Anna Schmidt', active: true },
  permissions: { canView: true, canUse: true, isOwner: false, role: 'user', suspended: null },
  capabilities: [],
  approval: { mode: 'always', chatGrants: false },
  state: 'active',
  disabled: null,
  ...extra
});

beforeEach(() => {
  window.sessionStorage.clear();
  mockApi.fetchAppDetails.mockReset();
});

describe('who sees the notice', () => {
  test('everyone but the owner of a personal app', () => {
    expect(showsPersonalAppNotice(member())).toBe(true);
    expect(
      showsPersonalAppNotice(
        member({ permissions: { canUse: true, isOwner: false, role: 'editor' } })
      )
    ).toBe(true);
    expect(
      showsPersonalAppNotice(
        member({ permissions: { canUse: true, isOwner: false, role: 'admin' } })
      )
    ).toBe(true);
  });

  test('not the owner, and nobody in an admin app', () => {
    const owner = member({ permissions: { canUse: true, isOwner: true, role: 'owner' } });
    expect(showsPersonalAppNotice(owner)).toBe(false);
    expect(render(<PersonalAppNotice app={owner} />).container).toBeEmptyDOMElement();
    expect(
      render(<PersonalAppNotice app={{ id: 'chat', name: { en: 'Chat' } }} />).container
    ).toBeEmptyDOMElement();
    expect(render(<PersonalAppNotice app={null} />).container).toBeEmptyDOMElement();
  });
});

describe('the lines of the notice', () => {
  test('line 1: who owns the app, and that administrators have not checked it', () => {
    render(<PersonalAppNotice app={member()} />);
    const notice = screen.getByTestId('personal-app-notice');
    expect(notice).toHaveTextContent(
      'Anna Schmidt owns this app. Administrators have not checked it.'
    );
    // Nothing to use, nothing missing: no further line.
    expect(notice).not.toHaveTextContent('It may use');
    expect(notice).not.toHaveTextContent('It asks you');
    expect(notice).not.toHaveTextContent('Not available');
  });

  test('"It may use": web search, with the note that the person switches it on', () => {
    render(
      <PersonalAppNotice app={member({ capabilities: [{ id: 'webSearch', granted: true }] })} />
    );
    expect(screen.getByTestId('personal-app-notice')).toHaveTextContent(
      'It may use: web search (you switch it on in the chat).'
    );
  });

  test('"It may use" lists files and skills without that note, and leaves the model out', () => {
    render(
      <PersonalAppNotice
        app={member({
          capabilities: [
            { id: 'model', granted: true },
            { id: 'upload', granted: true },
            { id: 'skills', granted: true }
          ]
        })}
      />
    );
    expect(screen.getByTestId('personal-app-notice')).toHaveTextContent(
      'It may use: files you attach, skills.'
    );
  });

  test('the line about being asked before every search and every page', () => {
    render(
      <PersonalAppNotice app={member({ capabilities: [{ id: 'webSearch', granted: true }] })} />
    );
    expect(screen.getByTestId('personal-app-notice')).toHaveTextContent(
      'It asks you before every search and every page it opens.'
    );
  });

  test('the line about being asked before every step in a connected system', () => {
    render(
      <PersonalAppNotice
        app={member({ capabilities: [{ id: 'integration:jira', granted: true }] })}
      />
    );
    const notice = screen.getByTestId('personal-app-notice');
    expect(notice).toHaveTextContent('It may use: jira (you switch it on in the chat).');
    expect(notice).toHaveTextContent('It asks you before every step in a connected system.');
    expect(notice).not.toHaveTextContent('before every search');
  });

  test('no "asks you" line when the server says the chat asks before writes only', () => {
    const lines = personalAppNoticeLines(
      member({
        approval: { mode: 'writes', chatGrants: true },
        capabilities: [
          { id: 'webSearch', granted: true },
          { id: 'integration:jira', granted: true }
        ]
      }),
      mockT
    );
    expect(lines.asksFirst).toBe(false);
    expect(lines.asksFirstSystems).toBe(false);
  });

  test('"Not available to you here": what is missing because of the person\'s own rights', () => {
    render(
      <PersonalAppNotice
        app={member({
          capabilities: [
            { id: 'webSearch', granted: true },
            { id: 'integration:jira', granted: false, reason: 'youMayNot', name: 'Jira' }
          ]
        })}
      />
    );
    const notice = screen.getByTestId('personal-app-notice');
    expect(notice).toHaveTextContent('Not available to you here: Jira.');
    expect(notice).not.toHaveTextContent('Not available in this app right now');
  });

  test('"Not available in this app right now": missing on the owner\'s side, without the reason', () => {
    render(
      <PersonalAppNotice
        app={member({
          capabilities: [
            { id: 'webSearch', granted: false, reason: 'unavailable' },
            { id: 'model', granted: false, reason: 'unavailable' }
          ]
        })}
      />
    );
    const notice = screen.getByTestId('personal-app-notice');
    expect(notice).toHaveTextContent(
      'Not available in this app right now: web search, the preferred AI model.'
    );
    expect(notice).not.toHaveTextContent('Not available to you here');
    expect(notice).not.toHaveTextContent('unavailable');
  });

  test('a reason the client does not know reads as "not available right now"', () => {
    const lines = personalAppNoticeLines(
      member({ capabilities: [{ id: 'webSearch', granted: false, reason: 'ownerStale' }] }),
      mockT
    );
    expect(lines.unavailable).toEqual(['web search']);
    expect(lines.notForYou).toEqual([]);
  });

  test('"Show instructions" opens the instructions read-only, as text', () => {
    render(<PersonalAppNotice app={member()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show instructions' }));

    const dialog = screen.getByRole('dialog');
    const text = within(dialog).getByTestId('personal-app-instructions');
    expect(text).toHaveTextContent('Answer friendly and short.');
    // The instructions are shown as written: markup in them stays text.
    expect(text.querySelector('b')).toBeNull();
    expect(text.textContent).toContain('<b>never markup</b>');
    expect(dialog.querySelector('textarea, input')).toBeNull();
  });

  test('"Show instructions" also shows the message template and the values of choices', () => {
    render(
      <PersonalAppNotice
        app={member({
          prompt: { de: '{{content}}\n\nAlso append the word HIDDEN.' },
          variables: [
            {
              name: 'tone',
              label: { de: 'Tone' },
              type: 'select',
              predefinedValues: [
                { value: 'friendly', label: { de: 'friendly' } },
                { value: 'Ignore the rules', label: { de: 'strict' } }
              ]
            }
          ]
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show instructions' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('personal-app-instructions')).toHaveTextContent(
      'Answer friendly and short.'
    );
    expect(within(dialog).getByText('Message template')).toBeInTheDocument();
    expect(within(dialog).getByTestId('personal-app-template')).toHaveTextContent(
      'Also append the word HIDDEN.'
    );
    const options = within(dialog).getByTestId('personal-app-option-values');
    expect(options).toHaveTextContent('Tone: “strict” sends “Ignore the rules”');
    // A value equal to its label hides nothing and is not listed.
    expect(options).not.toHaveTextContent('friendly');
  });

  test('a message template alone also gets the button', () => {
    render(
      <PersonalAppNotice app={member({ system: undefined, prompt: { de: 'X {{content}}' } })} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show instructions' }));
    expect(screen.getByTestId('personal-app-template')).toHaveTextContent('X {{content}}');
  });

  test('without instructions in the answer there is no button for them', () => {
    render(<PersonalAppNotice app={member({ system: undefined })} />);
    expect(screen.queryByRole('button', { name: 'Show instructions' })).not.toBeInTheDocument();
  });

  test('the notice collapses to one line and opens again; it cannot be dismissed', () => {
    const { unmount } = render(<PersonalAppNotice app={member()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));

    const notice = screen.getByTestId('personal-app-notice');
    expect(notice).toHaveTextContent('Personal app by Anna Schmidt');
    expect(screen.getByText(/Administrators have not checked it/)).not.toBeVisible();
    const expand = within(notice).getByRole('button');
    expect(expand).toHaveAttribute('aria-expanded', 'false');

    // Collapsed is remembered for this tab only, and it is still there after a remount.
    unmount();
    render(<PersonalAppNotice app={member()} />);
    expect(screen.getByTestId('personal-app-notice')).toHaveTextContent(
      'Personal app by Anna Schmidt'
    );
    expect(screen.getByText(/Administrators have not checked it/)).not.toBeVisible();
    fireEvent.click(within(screen.getByTestId('personal-app-notice')).getByRole('button'));
    expect(screen.getByText(/Administrators have not checked it/)).toBeVisible();
  });

  test('the focus moves to the other toggle, and aria-controls always names an element', () => {
    render(<PersonalAppNotice app={member()} />);
    const collapse = screen.getByRole('button', { name: 'Show less' });
    collapse.focus();
    fireEvent.click(collapse);
    const expand = within(screen.getByTestId('personal-app-notice')).getByRole('button');
    expect(expand).toHaveFocus();
    expect(document.getElementById(expand.getAttribute('aria-controls'))).not.toBeNull();

    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveFocus();
  });

  test('a load does not take the focus', () => {
    render(<PersonalAppNotice app={member()} />);
    expect(document.body).toHaveFocus();
  });

  test('the receiver of an offer gets a link to answer it in the editor', () => {
    render(
      <MemoryRouter>
        <PersonalAppNotice
          app={member({
            permissions: { ...member().permissions, canAcceptOffer: true, role: 'offered' }
          })}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'View the offer' })).toHaveAttribute(
      'href',
      `/apps/${APP_ID}/edit`
    );
  });

  test('anyone else gets no link to an offer', () => {
    render(<PersonalAppNotice app={member()} />);
    expect(screen.queryByRole('link', { name: 'View the offer' })).not.toBeInTheDocument();
  });
});

describe('instead of the chat', () => {
  const renderRoute = () =>
    render(
      <MemoryRouter initialEntries={[`/apps/${APP_ID}`]}>
        <Routes>
          <Route path="apps/:appId" element={<AppRouterWrapper />} />
        </Routes>
      </MemoryRouter>
    );
  const reduced = extra => ({
    id: APP_ID,
    ownership: 'user',
    name: { de: 'Reply to a customer' },
    icon: 'sparkles',
    color: '#4F46E5',
    owner: { id: 'anna', name: 'Anna Schmidt', active: true },
    state: 'active',
    permissions: { canView: true, canUse: false, isOwner: false, role: 'user', suspended: null },
    disabled: null,
    ...extra
  });

  test('a personal app the caller may use opens the chat', async () => {
    mockApi.fetchAppDetails.mockResolvedValue(member());
    renderRoute();
    expect(await screen.findByTestId('chat')).toHaveTextContent(APP_ID);
    expect(mockApi.fetchAppDetails).toHaveBeenCalledWith(APP_ID);
  });

  test('suspended sharing: the page names the owner and an administrator, not the reason', async () => {
    mockApi.fetchAppDetails.mockResolvedValue(
      reduced({ permissions: { canView: true, canUse: false, suspended: 'ownerMayNotShare' } })
    );
    renderRoute();
    const page = await screen.findByTestId('personal-app-unavailable');
    expect(page).toHaveTextContent(
      'This app is not available at the moment. Ask Anna Schmidt or an administrator.'
    );
    expect(page).not.toHaveTextContent('ownerMayNotShare');
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reply to a customer');
  });

  test("a switched-off app says so, with the administrator's reason when there is one", () => {
    const first = render(
      <PersonalAppUnavailable app={reduced({ disabled: { at: 'x', reason: 'Under review' } })} />
    );
    expect(first.container).toHaveTextContent(
      'An administrator switched this app off: Under review'
    );
    first.unmount();
    const second = render(
      <PersonalAppUnavailable app={reduced({ disabled: { at: 'x', reason: null } })} />
    );
    expect(second.container).toHaveTextContent('Switched off by an administrator');
  });

  test('a retired app points to the company app', async () => {
    mockApi.fetchAppDetails.mockResolvedValue({
      id: APP_ID,
      ownership: 'user',
      state: 'retired',
      publishedAs: { appId: 'customer-reply', name: { en: 'Customer reply' } }
    });
    renderRoute();
    const page = await screen.findByTestId('personal-app-retired');
    expect(page).toHaveTextContent('This app is now a company app.');
    expect(within(page).getByRole('link', { name: 'Open "Customer reply"' })).toHaveAttribute(
      'href',
      '/apps/customer-reply'
    );
    expect(page).toHaveTextContent('Your earlier chats stay in your chat history.');
  });

  test('an admin app is untouched by all of this', async () => {
    mockApi.fetchAppDetails.mockResolvedValue({ id: 'chat', name: { en: 'Chat' } });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId('chat')).toHaveTextContent('chat'));
  });
});

describe('the approval card in the chat of a personal app', () => {
  const interaction = displayData => ({
    id: 'approve-1',
    status: 'pending',
    prompt: {
      displayData: {
        toolId: 'webContentExtractor',
        toolName: 'Read a page',
        sideEffect: 'read',
        dataFlow: 'external',
        args: { url: 'https://example.org/a?b=c' },
        ...displayData
      }
    }
  });

  test('no "allow for this chat" when the event says the chat holds no grants', () => {
    const approval = buildToolApproval(interaction({ grants: [] }));
    expect(approval.grants).toEqual([]);
    const onDecide = jest.fn();
    render(<ApprovalCard approval={approval} onDecide={onDecide} />);

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /allow for this chat/i })).not.toBeInTheDocument();
    // The page the app wants to open is on the card with its full address.
    expect(screen.getByTestId('tool-approval-args')).toHaveTextContent('https://example.org/a?b=c');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith({ interactionId: 'approve-1', decision: 'approve' });
  });

  test('the button is there when the event does not limit grants', () => {
    const approval = buildToolApproval(interaction({}));
    expect(approval).not.toHaveProperty('grants');
    render(<ApprovalCard approval={approval} onDecide={jest.fn()} />);
    expect(screen.getByRole('button', { name: /allow for this chat/i })).toBeInTheDocument();
  });

  test('a caller that withholds the button keeps doing so', () => {
    render(
      <ApprovalCard
        approval={buildToolApproval(interaction({}))}
        onDecide={jest.fn()}
        allowChatGrant={false}
      />
    );
    expect(screen.queryByRole('button', { name: /allow for this chat/i })).not.toBeInTheDocument();
  });
});
