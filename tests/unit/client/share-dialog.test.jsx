import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The one share dialog of a chat page. It replaced two header buttons — a
 * "Share" that made a short link to the app and a "Share chat" that made a
 * read-only link to the conversation — whose difference nobody could tell
 * from the icon: the app link felt like it shared the chat. These tests pin
 * that the dialog names what each link carries, opens on the conversation
 * once there is one, and that the app link is a one-click action.
 */

const mockT = (key, options) => {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object') {
    const template =
      (options.count === 1 ? options.defaultValue_one : options.defaultValue_other) ??
      options.defaultValue ??
      key;
    return String(template).replace(/{{(\w+)}}/g, (_, name) => String(options[name] ?? ''));
  }
  return key;
};
const mockTranslation = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => mockTranslation
}));

const mockApi = {
  createShortLink: jest.fn(),
  getShortLink: jest.fn(),
  fetchChatShares: jest.fn(),
  createChatShare: jest.fn(),
  lookupUsers: jest.fn(),
  revokeChatShare: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  createShortLink: (...args) => mockApi.createShortLink(...args),
  getShortLink: (...args) => mockApi.getShortLink(...args),
  fetchChatShares: (...args) => mockApi.fetchChatShares(...args),
  createChatShare: (...args) => mockApi.createChatShare(...args),
  lookupUsers: (...args) => mockApi.lookupUsers(...args),
  revokeChatShare: (...args) => mockApi.revokeChatShare(...args)
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: { chats: { sharing: { enabled: true } } } })
}));
// A subpath deployment, so the links have to carry the base path.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildPath: path => `/ihub${path}`
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const ShareDialog = require('../../../client/src/features/chat/components/ShareDialog').default;

const appLink = { appId: 'acme', path: '/ihub/apps/acme', params: { model: 'gpt' } };

function renderDialog(props = {}) {
  return render(
    <ShareDialog isOpen onClose={() => {}} appName={{ en: 'Acme' }} appLink={appLink} {...props} />
  );
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchChatShares.mockResolvedValue({ items: [] });
});

describe('ShareDialog', () => {
  it('offers both targets and opens on a conversation that has messages', async () => {
    renderDialog({ chatShare: { chatId: 'c1', ready: true } });

    expect(screen.getByRole('heading', { name: 'Share' })).toBeInTheDocument();
    const chatTab = screen.getByRole('tab', { name: /This conversation/ });
    const appTab = screen.getByRole('tab', { name: /Link to the app/ });
    expect(chatTab).toHaveAttribute('aria-selected', 'true');
    expect(appTab).toHaveAttribute('aria-selected', 'false');
    expect(
      within(screen.getByRole('tabpanel')).getByText('Who can open the link')
    ).toBeInTheDocument();
    expect(await screen.findByText('This chat has not been shared yet.')).toBeInTheDocument();
    expect(mockApi.fetchChatShares).toHaveBeenCalledWith('c1');

    fireEvent.click(appTab);
    expect(appTab).toHaveAttribute('aria-selected', 'true');
    expect(
      within(screen.getByRole('tabpanel')).getByText(
        'A short link that opens Acme for a new chat. Your conversation is not part of it.'
      )
    ).toBeInTheDocument();
  });

  it('moves between the targets with the arrow keys', async () => {
    renderDialog({ chatShare: { chatId: 'c1', ready: true } });
    await screen.findByText('This chat has not been shared yet.');
    const chatTab = screen.getByRole('tab', { name: /This conversation/ });
    const appTab = screen.getByRole('tab', { name: /Link to the app/ });

    fireEvent.keyDown(chatTab, { key: 'ArrowRight' });
    expect(appTab).toHaveAttribute('aria-selected', 'true');
    expect(appTab).toHaveFocus();
    fireEvent.keyDown(appTab, { key: 'ArrowRight' });
    expect(chatTab).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the app link while the conversation has no message yet', () => {
    renderDialog({ chatShare: { chatId: 'c1', ready: false } });

    expect(screen.getByRole('tab', { name: /Link to the app/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    fireEvent.click(screen.getByRole('tab', { name: /This conversation/ }));
    expect(
      screen.getByText('Send a first message — a conversation can be shared once it has started.')
    ).toBeInTheDocument();
    expect(mockApi.fetchChatShares).not.toHaveBeenCalled();
  });

  it('shows the app link alone, titled as such, where chats cannot be shared', () => {
    renderDialog();

    expect(screen.getByRole('heading', { name: 'Share app' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create link/ })).toBeEnabled();
  });

  it('shows the conversation alone, titled as such, where short links are off', async () => {
    renderDialog({ appLink: null, chatShare: { chatId: 'c1', ready: true } });

    expect(screen.getByRole('heading', { name: 'Share chat' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByText('Who can open the link')).toBeInTheDocument();
    expect(await screen.findByText('This chat has not been shared yet.')).toBeInTheDocument();
  });
});

describe('ShareDialog app link', () => {
  it('creates a link in one click, with a code the server picks, under the base path', async () => {
    mockApi.createShortLink.mockResolvedValue({ code: 'Ab12Cd' });
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /Create link/ }));

    await waitFor(() => expect(mockApi.createShortLink).toHaveBeenCalledTimes(1));
    const body = mockApi.createShortLink.mock.calls[0][0];
    expect(body).toMatchObject({
      appId: 'acme',
      path: '/ihub/apps/acme',
      params: { model: 'gpt' },
      includeParams: true,
      expiresAt: null
    });
    expect(body).not.toHaveProperty('code');
    expect(await screen.findByRole('textbox', { name: 'Share link' })).toHaveValue(
      'http://localhost/ihub/s/Ab12Cd'
    );
    expect(mockApi.getShortLink).not.toHaveBeenCalled();
  });

  it('checks a custom code before the link can be created', async () => {
    renderDialog();
    const codeInput = screen.getByLabelText('Custom short code');
    const create = screen.getByRole('button', { name: /Create link/ });

    fireEvent.change(codeInput, { target: { value: 'abc' } });
    expect(screen.getByText('Code must be at least 5 characters')).toBeInTheDocument();
    expect(create).toBeDisabled();

    mockApi.getShortLink.mockResolvedValue({ code: 'taken1' });
    fireEvent.change(codeInput, { target: { value: 'taken1' } });
    expect(create).toBeDisabled();
    expect(await screen.findByText('Code taken')).toBeInTheDocument();
    expect(create).toBeDisabled();

    mockApi.getShortLink.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
    fireEvent.change(codeInput, { target: { value: 'free12' } });
    expect(await screen.findByText('Code available')).toBeInTheDocument();
    expect(create).toBeEnabled();

    mockApi.createShortLink.mockResolvedValue({ code: 'free12' });
    fireEvent.click(create);
    await waitFor(() =>
      expect(mockApi.createShortLink).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'free12' })
      )
    );
  });
});
