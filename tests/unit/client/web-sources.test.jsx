/**
 * The web sources behind an answer, in the chat (issue #2520):
 *  - links to cited sources become numbered badges; other links stay links
 *    (utils/webCitationTransformer.js);
 *  - hovering or focusing a badge highlights its passage and its card, a click
 *    or tap opens the sources view on that card and pins the highlight, and
 *    hovering a card highlights the passages citing it (StreamingMarkdown,
 *    WebSearchSources, webSourcesStore);
 *  - the sources view lists what the answer cites and what it only considered;
 *  - a reopened chat restores the record (transformStoredMessage);
 *  - the input bar shows when web search is on, and the model picker marks the
 *    models it works with.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { resolveCitations } from '../../../shared/webCitations.js';
import {
  applyCitationHighlight,
  transformWebCitations
} from '../../../client/src/utils/webCitationTransformer';
import StreamingMarkdown from '../../../client/src/features/chat/components/StreamingMarkdown';
import WebSearchSources from '../../../client/src/features/chat/components/WebSearchSources';
import ModelSelector from '../../../client/src/features/chat/components/ModelSelector';
import {
  _resetWebSourcesStore,
  currentCitationHighlight
} from '../../../client/src/features/chat/webSourcesStore';
import {
  modelSupportsWebSearch,
  webSearchLabel
} from '../../../client/src/features/chat/webSearch';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions, maybeOptions) => {
      const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
      if (typeof defaultOrOptions !== 'string') {
        return options.count !== undefined ? `${key}:${options.count}` : key;
      }
      return Object.entries(options).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, value),
        defaultOrOptions
      );
    }
  })
}));

jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const webSearch = {
  queries: ['what is langdock'],
  sources: [
    {
      url: 'https://langdock.com/',
      title: 'Langdock | The Platform for AI Adoption',
      snippet: 'Langdock enables you to roll out AI safely.',
      favicon: 'https://imgs.search.brave.com/langdock.png',
      publishedDate: '2026-09-01T00:00:00.000Z'
    },
    {
      url: 'https://docs.langdock.com/',
      title: 'Docs',
      read: true,
      wordCount: 812,
      truncated: true
    },
    { url: 'https://www.ycombinator.com/companies/langdock', title: 'Langdock | Y Combinator' }
  ]
};
const answer =
  'Langdock is an AI platform for companies [1](https://langdock.com/).\n\n' +
  'Read [the documentation](https://docs.langdock.com/) for details. ' +
  'Unrelated [link](https://elsewhere.example/).';

const citationsFor = (content = answer) => {
  const view = resolveCitations(content, webSearch);
  return {
    view,
    webCitations: {
      messageKey: 'msg-1',
      numbers: view.numbers,
      byNumber: new Map(view.cited.map(source => [source.n, source]))
    }
  };
};

beforeEach(() => {
  act(() => _resetWebSourcesStore());
});

describe('transformWebCitations', () => {
  const { webCitations } = citationsFor();

  test('replaces a marker link with a numbered badge and keeps worded links', () => {
    const html = transformWebCitations(
      '<p>AI platform <a href="https://langdock.com/">1</a>.</p>' +
        '<p>Read <a href="https://docs.langdock.com/">the documentation</a>.</p>',
      webCitations
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const badges = doc.querySelectorAll('a.web-citation');
    expect([...badges].map(b => b.textContent)).toEqual(['1', '2']);
    expect(badges[0].getAttribute('data-web-citation')).toBe('1');
    // The worded link stays, the badge follows it.
    expect(
      doc.querySelector('a[href="https://docs.langdock.com/"]:not(.web-citation)').textContent
    ).toBe('the documentation');
  });

  test('leaves links to anything the turn did not return alone', () => {
    const input = '<p><a href="https://elsewhere.example/">1</a></p>';
    expect(transformWebCitations(input, webCitations)).toBe(input);
  });

  test('turns ([host](url), [host](url)) into a run of badges', () => {
    const html = transformWebCitations(
      '<p>Claim (<a href="https://langdock.com/?utm_source=openai">langdock.com</a>, <a href="https://docs.langdock.com/">docs.langdock.com</a>).</p>',
      webCitations
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('p').textContent).toBe('Claim12.');
  });

  test('highlights the badges of a citation and the passages they sit in', () => {
    const container = document.createElement('div');
    container.innerHTML = transformWebCitations(
      '<p>One <a href="https://langdock.com/">1</a></p><ul><li>Two <a href="https://langdock.com/">1</a></li></ul><p>Three</p>',
      webCitations
    );
    applyCitationHighlight(container, 1);
    expect(container.querySelectorAll('.web-citation-active')).toHaveLength(2);
    expect(container.querySelectorAll('.web-citation-passage')).toHaveLength(2);
    expect(container.querySelector('p:last-child')).not.toHaveClass('web-citation-passage');
    applyCitationHighlight(container, null);
    expect(container.querySelectorAll('.web-citation-passage')).toHaveLength(0);
  });
});

describe('inline citations in a rendered answer', () => {
  test('hover highlights, a click opens the sources view and pins the highlight', () => {
    const { webCitations } = citationsFor();
    const { container } = render(
      <StreamingMarkdown content={answer} webCitations={webCitations} />
    );
    const badges = container.querySelectorAll('a.web-citation');
    expect([...badges].map(b => b.textContent)).toEqual(['1', '2']);
    expect(container.querySelector('a[href="https://elsewhere.example/"]')).not.toHaveClass(
      'web-citation'
    );

    fireEvent.mouseOver(badges[1]);
    expect(currentCitationHighlight()).toEqual({ messageKey: 'msg-1', n: 2 });
    expect(badges[1].closest('p')).toHaveClass('web-citation-passage');
    fireEvent.mouseOut(badges[1]);
    expect(currentCitationHighlight()).toBeNull();

    fireEvent.click(badges[0]);
    expect(currentCitationHighlight()).toEqual({ messageKey: 'msg-1', n: 1 });
    // Pinned: a hover elsewhere shows on top and the pin returns after it.
    fireEvent.mouseOver(badges[1]);
    expect(currentCitationHighlight().n).toBe(2);
    fireEvent.mouseOut(badges[1]);
    expect(currentCitationHighlight().n).toBe(1);
  });

  test('keyboard focus highlights like hover', () => {
    const { webCitations } = citationsFor();
    const { container } = render(
      <StreamingMarkdown content={answer} webCitations={webCitations} />
    );
    const badge = container.querySelector('a.web-citation');
    fireEvent.focusIn(badge);
    expect(currentCitationHighlight()).toEqual({ messageKey: 'msg-1', n: 1 });
  });
});

describe('WebSearchSources', () => {
  const renderSources = () => {
    const { view } = citationsFor();
    return render(<WebSearchSources messageKey="msg-1" webSearch={webSearch} citations={view} />);
  };

  test('shows a "Searched for" entry that opens the sources view', () => {
    renderSources();
    const entry = screen.getByRole('button', { name: /Searched for “what is langdock”/ });
    expect(entry).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(entry);
    expect(entry).toHaveAttribute('aria-expanded', 'true');

    const dialog = screen.getByRole('dialog', { name: 'Sources' });
    const [cited, considered] = dialog.querySelectorAll('section');
    expect(within(cited).getByText('Cited in this answer')).toBeInTheDocument();
    expect(within(cited).getByText('Langdock | The Platform for AI Adoption')).toBeInTheDocument();
    expect(within(cited).getByText('Docs')).toBeInTheDocument();
    expect(within(considered).getByText('Also considered')).toBeInTheDocument();
    expect(within(considered).getByText('Langdock | Y Combinator')).toBeInTheDocument();
    // The card's link opens the page in a new tab.
    const link = within(cited).getByText('Docs').closest('a');
    expect(link).toHaveAttribute('href', 'https://docs.langdock.com/');
    expect(link).toHaveAttribute('target', '_blank');
    // Read status, words read and the truncated hint.
    expect(within(cited).getByText('toolActivity.wordsRead:812')).toBeInTheDocument();
    expect(within(cited).getByText('truncated')).toBeInTheDocument();
  });

  test('hovering a card highlights the passages that cite it', () => {
    renderSources();
    fireEvent.click(screen.getByRole('button', { name: /Searched for/ }));
    const card = screen.getByText('Docs').closest('li');
    fireEvent.mouseEnter(card);
    expect(currentCitationHighlight()).toEqual({ messageKey: 'msg-1', n: 2 });
    fireEvent.mouseLeave(card);
    expect(currentCitationHighlight()).toBeNull();
  });

  test('closes with Escape', () => {
    renderSources();
    fireEvent.click(screen.getByRole('button', { name: /Searched for/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the phone sheet is modal and keeps Tab inside it', () => {
    // No matchMedia in jsdom: the view renders as the phone sheet.
    renderSources();
    fireEvent.click(screen.getByRole('button', { name: /Searched for/ }));
    const dialog = screen.getByRole('dialog', { name: 'Sources' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    // The trap takes the Tab key (fireEvent returns false when it was prevented).
    expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(false);
  });

  test('the desktop side panel is not modal: the answer stays usable next to it', () => {
    const original = window.matchMedia;
    window.matchMedia = jest.fn(() => ({
      matches: true,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    }));
    try {
      renderSources();
      fireEvent.click(screen.getByRole('button', { name: /Searched for/ }));
      const dialog = screen.getByRole('dialog', { name: 'Sources' });
      expect(dialog).not.toHaveAttribute('aria-modal');
      const close = within(dialog).getByRole('button', { name: 'Close' });
      expect(close).toHaveFocus();
      expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });

  test('labels several searches by their count', () => {
    const t = (key, options) => (options?.count !== undefined ? `${key}:${options.count}` : key);
    expect(webSearchLabel(t, { queries: ['a', 'b', 'c'] })).toBe('webSources.searches:3');
  });
});

describe('a reopened chat', () => {
  test('restores the web search record of a stored answer', () => {
    const message = transformStoredMessage({
      id: 'm1',
      role: 'assistant',
      content: answer,
      webSearch: { queries: ['what is langdock'], sources: webSearch.sources }
    });
    expect(message.webSearch.queries).toEqual(['what is langdock']);
    expect(message.answerSource).toEqual({ sources: ['websearch'], type: 'mixed' });
    expect(resolveCitations(message.content, message.webSearch).cited).toHaveLength(2);
    expect(transformStoredMessage({ id: 'm2', role: 'assistant', content: 'x' }).webSearch).toBe(
      undefined
    );
  });
});

describe('model picker web search marker', () => {
  const app = extra => ({
    id: 'web',
    websearch: { enabled: true, useNativeSearch: true },
    websearchAvailability: { native: ['google', 'openai-responses', 'anthropic'], script: false },
    ...extra
  });

  test('works natively on providers that run search, else through tool calling', () => {
    expect(modelSupportsWebSearch(app(), { provider: 'anthropic' })).toBe(true);
    expect(
      modelSupportsWebSearch(app(), { provider: 'anthropic', nativeWebSearch: { enabled: false } })
    ).toBe(false);
    expect(modelSupportsWebSearch(app(), { provider: 'mistral', supportsTools: true })).toBe(false);
    expect(
      modelSupportsWebSearch(app({ websearchAvailability: { native: [], script: true } }), {
        provider: 'mistral',
        supportsTools: true
      })
    ).toBe(true);
    expect(modelSupportsWebSearch({ id: 'plain' }, { provider: 'openai' })).toBeNull();
  });

  test('marks each model in the list', () => {
    render(
      <ModelSelector
        app={app()}
        models={[
          { id: 'claude', name: 'Claude', provider: 'anthropic', supportsTools: true },
          { id: 'local', name: 'Local', provider: 'openai', supportsTools: true }
        ]}
        selectedModel="claude"
        onModelChange={() => {}}
        currentLanguage="en"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }));
    expect(screen.getByText('Web search works with this model')).toBeInTheDocument();
    expect(
      screen.getByText('Web search does not work with this model in this app')
    ).toBeInTheDocument();
  });
});
