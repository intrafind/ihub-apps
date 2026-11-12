import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';
import {
  _resetSourcesStore,
  closeSources,
  openSources
} from '../../../client/src/features/chat/sources/sourcesStore';

/**
 * Where an answer's sources sit (#3521): everything about them is at the
 * answer's end — the list of what it cites, then one row with the "N results"
 * entry that opens the sources panel and the badge saying what the answer is
 * based on. Only once the answer is complete, so nothing grows or jumps under
 * the text while it streams; the inline badges open the panel meanwhile.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : fallback?.defaultValue || key;
      const values = typeof fallback === 'object' ? fallback : options || {};
      return Object.entries(values).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
        text
      );
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { featuresMap: {} } })
}));

jest.mock('../../../client/src/api', () => ({
  sendMessageFeedback: jest.fn(),
  answerInteraction: jest.fn()
}));

jest.mock('../../../client/src/api/endpoints/integrationFiles', () => ({
  __esModule: true,
  fetchIntegrationFileContent: jest.fn(),
  fetchIntegrationFileMetadata: jest.fn(() => Promise.resolve({}))
}));

jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="content">{content}</div>
}));

jest.mock('../../../client/src/shared/components/CustomResponseRenderer', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/features/workflows/components/AppSelectionModal', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: { get: jest.fn(), post: jest.fn() },
  default: { get: jest.fn(), post: jest.fn() }
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`,
  buildAssetUrl: path => path,
  buildPath: path => path
}));

const message = {
  id: 'msg-1',
  role: 'assistant',
  content: 'Langdock is an AI platform [1](https://langdock.com/).',
  sources: {
    queries: ['what is langdock'],
    items: [
      {
        id: 'url:langdock.com',
        provider: 'web',
        kind: 'page',
        url: 'https://langdock.com/',
        title: 'Langdock',
        private: false
      }
    ]
  }
};

function renderMessage(overrides = {}) {
  return render(
    <ChatMessage message={{ ...message, ...overrides }} appId="chat" chatId="chat-1" modelId="m" />
  );
}

const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const entryOf = () => screen.queryByRole('button', { name: 'sources.resultsCount' });
const webSearch = { answerBasis: [{ kind: 'web' }] };

beforeEach(() => {
  act(() => _resetSourcesStore());
});

test('the cited list and the results entry follow the answer, next to the badge', () => {
  renderMessage(webSearch);
  const content = screen.getByTestId('content');
  const cited = screen.getByRole('list', { name: 'Cited in this answer' });
  const entry = entryOf();
  const badge = screen.getByTestId('answer-basis-chip');

  expect(follows(content, cited)).toBe(true);
  expect(follows(cited, entry)).toBe(true);
  expect(follows(entry, badge)).toBe(true);
  // One row: the entry at the start, the badge at the end.
  expect(entry.parentElement).toBe(badge.closest('.ms-auto').parentElement);
  expect(badge.closest('.ms-auto')).toBeInTheDocument();
  // Nothing about the sources above the answer.
  expect(screen.getAllByRole('button').filter(button => follows(button, content))).toHaveLength(0);
});

test('the entry says how many results, not what was searched', () => {
  renderMessage();
  expect(entryOf()).toHaveTextContent('sources.resultsCount');
  expect(screen.queryByText(/Searched for/)).not.toBeInTheDocument();
});

test('without a badge (a failed or older answer), the entry is still there', () => {
  renderMessage({ error: true });
  expect(screen.queryByTestId('answer-basis-chip')).not.toBeInTheDocument();
  expect(entryOf()).toBeInTheDocument();
});

test('while the answer streams there is no entry, no cited list and no badge', () => {
  renderMessage({ ...webSearch, loading: true });
  expect(entryOf()).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Cited in this answer' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('answer-basis-chip')).not.toBeInTheDocument();
});

test('while it streams the inline badges still open the panel, and it stays open after', () => {
  const { rerender } = renderMessage({ loading: true });
  act(() => openSources('msg-1', 1));
  expect(screen.getByRole('dialog', { name: 'Sources' })).toBeInTheDocument();

  rerender(
    <ChatMessage
      message={{ ...message, loading: false }}
      appId="chat"
      chatId="chat-1"
      modelId="m"
    />
  );
  expect(screen.getByRole('dialog', { name: 'Sources' })).toBeInTheDocument();
  expect(entryOf()).toHaveAttribute('aria-expanded', 'true');
});

test('closing the panel returns focus to what opened it', () => {
  renderMessage();
  const list = screen.getByRole('list', { name: 'Cited in this answer' });
  const number = within(list).getByRole('button', { name: /source 1/ });
  fireEvent.click(number);
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' })).toHaveFocus();
  act(() => closeSources());
  expect(number).toHaveFocus();

  fireEvent.click(entryOf());
  act(() => closeSources());
  expect(entryOf()).toHaveFocus();
});

test('focus the user moved elsewhere stays there when the panel closes', () => {
  renderMessage();
  const number = within(screen.getByRole('list', { name: 'Cited in this answer' })).getByRole(
    'button',
    { name: /source 1/ }
  );
  // Opened from a number, closed with the entry: focus stays on the entry.
  fireEvent.click(number);
  const entry = entryOf();
  entry.focus();
  fireEvent.click(entry);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(entry).toHaveFocus();

  // Escape while typing elsewhere (the side panel is not modal): focus stays there.
  const box = document.createElement('textarea');
  document.body.appendChild(box);
  fireEvent.click(number);
  box.focus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(box).toHaveFocus();
  box.remove();
});

test('an answer rendered twice (phone and desktop layout) opens one panel', () => {
  render(
    <>
      <div className="md:hidden">
        <ChatMessage message={message} appId="chat" chatId="chat-1" modelId="m" />
      </div>
      <div className="hidden md:block">
        <ChatMessage message={message} appId="chat" chatId="chat-1" modelId="m" />
      </div>
    </>
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'sources.resultsCount' })[1]);
  expect(screen.getAllByRole('dialog', { name: 'Sources' })).toHaveLength(1);
});

test('an answer that found nothing has no divider and no entry, only its badge', () => {
  const { container } = renderMessage({ ...webSearch, sources: { queries: ['x'], items: [] } });
  expect(entryOf()).not.toBeInTheDocument();
  expect(screen.getByTestId('answer-basis-chip')).toBeInTheDocument();
  expect(container.querySelector('.border-t')).toBeNull();
});

describe('a list of sources the model wrote at the end (#3522)', () => {
  const withList =
    'Langdock is an AI platform [1](https://langdock.com/).\n\n---\n\n**Quellen:**\n' +
    '[1](https://langdock.com/) – Langdock';

  test('is left out of a finished answer: "Cited in this answer" lists it', () => {
    renderMessage({ content: withList });
    expect(screen.getByTestId('content').textContent).toBe(
      'Langdock is an AI platform [1](https://langdock.com/).'
    );
    expect(screen.getByRole('list', { name: 'Cited in this answer' })).toBeInTheDocument();
  });

  test('stays while the answer streams, before the cited list is there', () => {
    renderMessage({ content: withList, loading: true });
    expect(screen.getByTestId('content').textContent).toContain('Quellen:');
  });

  test('an answer without such a list is shown as it is', () => {
    renderMessage();
    expect(screen.getByTestId('content').textContent).toBe(message.content);
  });
});

describe('an answer that cites none of its sources', () => {
  // The search read two of its results; the model wrote no links.
  const page = (host, title, read) => ({
    id: `url:${host}`,
    provider: 'web',
    kind: 'page',
    url: `https://${host}/`,
    title,
    ...(read ? { read } : {}),
    private: false
  });
  const searched = {
    queries: ['berlin weather'],
    items: [
      page('weather.example', 'Berlin weather', { ok: true }),
      page('news.example', 'Berlin today', { ok: true }),
      page('blocked.example', 'Blocked page', { ok: false })
    ]
  };
  const uncited = 'It is sunny and 24 degrees, and the outdoor pools open this weekend.';

  test('lists the pages read for it where the cited list would be, never an empty cited list', () => {
    renderMessage({ ...webSearch, content: uncited, sources: searched });
    expect(screen.queryByRole('list', { name: 'Cited in this answer' })).not.toBeInTheDocument();
    expect(screen.queryByText('Cited in this answer')).not.toBeInTheDocument();
    const read = screen.getByRole('list', { name: 'Read for this answer' });
    expect(
      within(read)
        .getAllByRole('link')
        .map(link => link.getAttribute('href'))
    ).toEqual(['https://weather.example/', 'https://news.example/']);
    expect(within(read).queryByText('Blocked page')).not.toBeInTheDocument();
    // In the cited list's place: after the answer, before the entry and the badge.
    expect(follows(screen.getByTestId('content'), read)).toBe(true);
    expect(follows(read, entryOf())).toBe(true);
    expect(entryOf().parentElement).toHaveClass('mt-2');
  });

  test('with nothing read either, there is no list at all, only the entry and the badge', () => {
    const found = {
      queries: ['berlin weather'],
      items: [page('weather.example', 'Berlin weather'), page('news.example', 'Berlin today')]
    };
    renderMessage({ ...webSearch, content: uncited, sources: found });
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('Cited in this answer')).not.toBeInTheDocument();
    expect(entryOf()).toBeInTheDocument();
    expect(screen.getByTestId('answer-basis-chip')).toBeInTheDocument();
  });

  test('nothing is listed while the answer streams', () => {
    renderMessage({ ...webSearch, content: uncited, sources: searched, loading: true });
    expect(screen.queryByRole('list', { name: 'Read for this answer' })).not.toBeInTheDocument();
  });
});
