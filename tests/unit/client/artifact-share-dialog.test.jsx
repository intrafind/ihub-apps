import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Sharing one generated file: the dialog reuses the chat share form, minus the
 * uploaded-file options, and a public link can ask to be embeddable when the
 * administrator allows embedding.
 */

const mockT = (key, options) => {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object') {
    return String(options.defaultValue ?? key).replace(/{{(\w+)}}/g, (_, name) =>
      String(options[name] ?? '')
    );
  }
  return key;
};
const mockTranslation = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => mockTranslation
}));

const mockApi = {
  fetchChatShares: jest.fn(),
  fetchChatFiles: jest.fn(),
  createChatShare: jest.fn(),
  createArtifactShare: jest.fn(),
  lookupUsers: jest.fn(),
  revokeChatShare: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchChatShares: (...args) => mockApi.fetchChatShares(...args),
  fetchChatFiles: (...args) => mockApi.fetchChatFiles(...args),
  createChatShare: (...args) => mockApi.createChatShare(...args),
  createArtifactShare: (...args) => mockApi.createArtifactShare(...args),
  lookupUsers: (...args) => mockApi.lookupUsers(...args),
  revokeChatShare: (...args) => mockApi.revokeChatShare(...args)
}));

const mockSharing = { enabled: true, embedEnabled: true };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: { chats: { sharing: mockSharing } } })
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildPath: path => `/ihub${path}`
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const ArtifactShareDialog =
  require('../../../client/src/features/chat/components/ArtifactShareDialog').default;

const artifact = { id: 'art1', name: 'page.html' };

function renderDialog() {
  return render(<ArtifactShareDialog isOpen onClose={() => {}} chatId="c1" artifact={artifact} />);
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockSharing.embedEnabled = true;
  mockApi.fetchChatShares.mockResolvedValue({ items: [] });
  mockApi.fetchChatFiles.mockResolvedValue({ items: [{ id: 'f1', name: 'upload.pdf' }] });
  mockApi.createArtifactShare.mockImplementation(async (_chat, _artifact, body) => ({
    share: { id: 'shr_new', mode: body.mode, embeddable: body.embeddable === true }
  }));
});

test('lists only the links of this file and never offers the uploaded files', async () => {
  mockApi.fetchChatShares.mockResolvedValue({
    items: [
      {
        id: 'shr_a',
        mode: 'public',
        state: 'active',
        target: 'artifact',
        artifact: { id: 'art1' }
      },
      {
        id: 'shr_b',
        mode: 'public',
        state: 'active',
        target: 'artifact',
        artifact: { id: 'other' }
      },
      { id: 'shr_c', mode: 'public', state: 'active', target: 'chat' }
    ]
  });
  renderDialog();
  await screen.findByText('Links for this file');
  expect(mockApi.fetchChatShares).toHaveBeenCalledWith('c1', { artifactId: 'art1' });
  await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0));
  expect(screen.queryByTestId('share-files-access')).not.toBeInTheDocument();
  expect(mockApi.fetchChatFiles).not.toHaveBeenCalled();
});

test('creates a public embeddable link without a view limit and shows the embed code', async () => {
  renderDialog();
  fireEvent.click(await screen.findByDisplayValue('public'));
  fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }));
  fireEvent.click(screen.getByTestId('share-embeddable'));
  const views = screen.getByLabelText('Maximum opens');
  expect(views).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

  await waitFor(() => expect(mockApi.createArtifactShare).toHaveBeenCalledTimes(1));
  const [chatId, artifactId, body] = mockApi.createArtifactShare.mock.calls[0];
  expect([chatId, artifactId]).toEqual(['c1', 'art1']);
  expect(body).toMatchObject({ mode: 'public', embeddable: true, maxViews: null });
  expect(mockApi.createChatShare).not.toHaveBeenCalled();

  const code = await screen.findByLabelText('Embed code');
  expect(code.value).toContain('<iframe src="');
  expect(code.value).toContain('/ihub/share/shr_new/embed');
});

test('offers no embedding when the administrator has not enabled it', async () => {
  mockSharing.embedEnabled = false;
  renderDialog();
  fireEvent.click(await screen.findByDisplayValue('public'));
  expect(screen.queryByTestId('share-embeddable')).not.toBeInTheDocument();
});
