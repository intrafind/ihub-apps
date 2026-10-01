/**
 * Everything an answer found, in the chat (issue #2637) — web pages and
 * documents alike, whichever integration found them:
 *  - every citation scheme becomes the same numbered badge: links to a source
 *    (`[n](url)`, a document's deep link) and iAssistant's `<cite>` markers;
 *    other links stay links (utils/sourceCitationTransformer.js);
 *  - hovering or focusing a badge highlights its passage and its card, a click
 *    or tap (or Enter on a badge without a link) opens the sources panel on
 *    that card and pins the highlight (StreamingMarkdown, sourcesStore);
 *  - the panel lists what the answer cites and what it only considered, with
 *    one card design for pages and documents (AnswerSources);
 *  - a reopened chat restores the sources (transformStoredMessage);
 *  - the model picker marks the models web search works with.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { resolveCitations } from '../../../shared/sources/index.js';
import {
  applyCitationHighlight,
  transformSourceCitations
} from '../../../client/src/utils/sourceCitationTransformer';
import StreamingMarkdown from '../../../client/src/features/chat/components/StreamingMarkdown';
import AnswerSources from '../../../client/src/features/chat/components/AnswerSources';
import ModelSelector from '../../../client/src/features/chat/components/ModelSelector';
import {
  _resetSourcesStore,
  currentCitationHighlight,
  useSourcesState
} from '../../../client/src/features/chat/sources/sourcesStore';
import { sourcesLabel } from '../../../client/src/features/chat/sources/sourcesView';
import { modelSupportsWebSearch } from '../../../client/src/features/chat/webSearch';
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

jest.mock('../../../client/src/api/endpoints/sources', () => ({
  __esModule: true,
  fetchSourceContent: jest.fn(),
  fetchSourceMetadata: jest.fn(() => Promise.resolve({}))
}));

jest.mock('../../../client/src/features/workflows/components/AppSelectionModal', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const langdock = {
  id: 'url:langdock.com',
  provider: 'web',
  kind: 'page',
  url: 'https://langdock.com/',
  title: 'Langdock | The Platform for AI Adoption',
  snippet: 'Langdock enables you to roll out AI safely.',
  favicon: 'https://imgs.search.brave.com/langdock.png',
  publishedDate: '2026-09-01T00:00:00.000Z',
  private: false
};
const docs = {
  id: 'url:docs.langdock.com',
  provider: 'web',
  kind: 'page',
  url: 'https://docs.langdock.com/',
  title: 'Docs',
  read: { ok: true, words: 812, truncated: true },
  private: false
};
const yc = {
  id: 'url:ycombinator.com/companies/langdock',
  provider: 'web',
  kind: 'page',
  url: 'https://www.ycombinator.com/companies/langdock',
  title: 'Langdock | Y Combinator',
  private: false
};
const contract = {
  id: 'ifinder:sp-7f3a9c11',
  provider: 'ifinder',
  kind: 'document',
  title: 'Supplier contract ACME',
  url: 'https://sp.example/sites/legal/acme.pdf',
  site: 'SharePoint',
  fileName: 'acme.pdf',
  type: 'PDF',
  ref: { id: 'sp-7f3a9c11', scope: 'sales' },
  passages: [
    { text: 'The notice period is three months.', marker: 's:3' },
    { text: 'Either party may terminate in writing.', marker: 's:4' }
  ],
  markers: ['r:1'],
  private: true
};
const minutes = {
  id: 'ifinder:fs-1234abcd',
  provider: 'ifinder',
  kind: 'document',
  title: 'Board minutes',
  ref: { id: 'fs-1234abcd', scope: 'sales' },
  markers: ['r:2'],
  private: true
};

const sources = {
  queries: ['what is langdock'],
  items: [langdock, docs, yc, contract, minutes]
};
const answer =
  'Langdock is an AI platform for companies [1](https://langdock.com/).\n\n' +
  'Read [the documentation](https://docs.langdock.com/) for details. ' +
  'The notice period is three months <cite type="s">3</cite>. ' +
  'Unrelated [link](https://elsewhere.example/).';

const citationsFor = (content = answer) => {
  const view = resolveCitations(content, sources);
  return {
    view,
    citations: {
      messageKey: 'msg-1',
      numberOfUrl: view.numberOfUrl,
      numberOfMarker: view.numberOfMarker,
      byNumber: new Map(view.cited.map(source => [source.n, source]))
    }
  };
};

beforeEach(() => {
  act(() => _resetSourcesStore());
});

describe('transformSourceCitations', () => {
  const { citations } = citationsFor();

  test('replaces a marker link with a numbered badge and keeps worded links', () => {
    const html = transformSourceCitations(
      '<p>AI platform <a href="https://langdock.com/">1</a>.</p>' +
        '<p>Read <a href="https://docs.langdock.com/">the documentation</a>.</p>',
      citations
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const badges = doc.querySelectorAll('a.source-citation');
    expect([...badges].map(b => b.textContent)).toEqual(['1', '2']);
    expect(badges[0].getAttribute('data-source-citation')).toBe('1');
    // The worded link stays, the badge follows it.
    expect(
      doc.querySelector('a[href="https://docs.langdock.com/"]:not(.source-citation)').textContent
    ).toBe('the documentation');
  });

  test('turns iAssistant markers into the same badges, numbered with the rest', () => {
    const html = transformSourceCitations(
      '<p>Three months <cite type="s">3</cite>, see also <cite type="r">2</cite> and <cite type="r">9</cite>.</p>',
      citationsFor(
        'Langdock [1](https://langdock.com/). Docs [2](https://docs.langdock.com/). ' +
          'Three months <cite type="s">3</cite>, see <cite type="r">2</cite>.'
      ).citations
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const badges = [...doc.querySelectorAll('a.source-citation')];
    // Passage 3 belongs to the contract (cited third), result 2 is the minutes (fourth).
    expect(badges.map(b => b.textContent)).toEqual(['3', '4']);
    // The contract has a link to open; the minutes do not: that badge is a button.
    expect(badges[0].getAttribute('href')).toBe('https://sp.example/sites/legal/acme.pdf');
    expect(badges[1].hasAttribute('href')).toBe(false);
    expect(badges[1].getAttribute('role')).toBe('button');
    expect(badges[1].getAttribute('tabindex')).toBe('0');
    // A marker no source carries stays as the model wrote it.
    expect(doc.querySelector('cite[type="r"]').textContent).toBe('9');
  });

  test('leaves links to anything the answer did not find alone', () => {
    const input = '<p><a href="https://elsewhere.example/">1</a></p>';
    expect(transformSourceCitations(input, citations)).toBe(input);
  });

  test('turns ([host](url), [host](url)) into a run of badges', () => {
    const html = transformSourceCitations(
      '<p>Claim (<a href="https://langdock.com/?utm_source=openai">langdock.com</a>, <a href="https://docs.langdock.com/">docs.langdock.com</a>).</p>',
      citations
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('p').textContent).toBe('Claim12.');
  });

  test('highlights the badges of a citation and the passages they sit in', () => {
    const container = document.createElement('div');
    container.innerHTML = transformSourceCitations(
      '<p>One <a href="https://langdock.com/">1</a></p><ul><li>Two <a href="https://langdock.com/">1</a></li></ul><p>Three</p>',
      citations
    );
    applyCitationHighlight(container, 1);
    expect(container.querySelectorAll('.source-citation-active')).toHaveLength(2);
    expect(container.querySelectorAll('.source-citation-passage')).toHaveLength(2);
    expect(container.querySelector('p:last-child')).not.toHaveClass('source-citation-passage');
    applyCitationHighlight(container, null);
    expect(container.querySelectorAll('.source-citation-passage')).toHaveLength(0);
  });
});

describe('inline citations in a rendered answer', () => {
  test('hover highlights, a click opens the sources panel and pins the highlight', () => {
    const { citations } = citationsFor();
    const { container } = render(<StreamingMarkdown content={answer} citations={citations} />);
    const badges = container.querySelectorAll('a.source-citation');
    expect([...badges].map(b => b.textContent)).toEqual(['1', '2', '3']);
    expect(container.querySelector('a[href="https://elsewhere.example/"]')).not.toHaveClass(
      'source-citation'
    );

    fireEvent.mouseOver(badges[1]);
    expect(currentCitationHighlight()).toEqual({ messageKey: 'msg-1', n: 2 });
    expect(badges[1].closest('p')).toHaveClass('source-citation-passage');
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

  test('keyboard focus highlights like hover; Enter presses a badge without a link', () => {
    const content = 'Minutes <cite type="r">2</cite>.';
    const { citations } = citationsFor(content);
    let open = null;
    function Probe() {
      open = useSourcesState().open;
      return null;
    }
    const { container } = render(
      <>
        <StreamingMarkdown content={content} citations={citations} />
        <Probe />
      </>
    );
    const badge = container.querySelector('a.source-citation');
    fireEvent.focusIn(badge);
    expect(currentCitationHighlight()).toEqual({ messageKey: 'msg-1', n: 1 });
    fireEvent.keyDown(badge, { key: 'Enter' });
    expect(open).toEqual({ messageKey: 'msg-1', focus: 1 });
  });
});

describe('AnswerSources', () => {
  const renderSources = (props = {}) => {
    const { view } = citationsFor();
    return render(
      <AnswerSources messageKey="msg-1" sources={sources} citations={view} {...props} />
    );
  };

  test('shows a "Searched for" entry that opens the sources panel', () => {
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
    expect(within(cited).getByText('Supplier contract ACME')).toBeInTheDocument();
    expect(within(considered).getByText('Also considered')).toBeInTheDocument();
    expect(within(considered).getByText('Langdock | Y Combinator')).toBeInTheDocument();
    expect(within(considered).getByText('Board minutes')).toBeInTheDocument();
    // The card's link opens the page in a new tab.
    const link = within(cited).getByText('Docs').closest('a');
    expect(link).toHaveAttribute('href', 'https://docs.langdock.com/');
    expect(link).toHaveAttribute('target', '_blank');
    // Read status, words read and the truncated hint.
    expect(within(cited).getByText('toolActivity.wordsRead:812')).toBeInTheDocument();
    expect(within(cited).getByText('truncated')).toBeInTheDocument();
  });

  // A source's card in the open panel (the cited list under the answer names
  // the same sources).
  const cardOf = title => within(screen.getByRole('dialog')).getByText(title).closest('li');

  test('a document card shows where it lives, its passages and its menu', () => {
    renderSources();
    fireEvent.click(screen.getByRole('button', { name: /Searched for/ }));
    const card = cardOf('Supplier contract ACME');
    expect(within(card).getByText('SharePoint')).toBeInTheDocument();
    expect(within(card).getByText('acme.pdf')).toBeInTheDocument();
    // The first passage is the excerpt; all of them fold out.
    expect(within(card).getByText('“The notice period is three months.”')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'sources.passages:2' }));
    expect(within(card).getByText('Either party may terminate in writing.')).toBeInTheDocument();
    expect(
      within(card).getAllByRole('button', { name: 'Show this passage in the document' })
    ).toHaveLength(2);
    fireEvent.click(within(card).getByTitle('Actions'));
    expect(within(card).getByText('Preview (PDF)')).toBeInTheDocument();
    expect(within(card).getByText('Download')).toBeInTheDocument();
    expect(within(card).getByText('Details')).toBeInTheDocument();
  });

  test('hovering a card highlights the passages that cite it', () => {
    renderSources();
    fireEvent.click(screen.getByRole('button', { name: /Searched for/ }));
    const card = cardOf('Docs');
    fireEvent.mouseEnter(card);
    expect(currentCitationHighlight()).toEqual({ messageKey: 'msg-1', n: 2 });
    fireEvent.mouseLeave(card);
    expect(currentCitationHighlight()).toBeNull();
  });

  test('closes with Escape, but a menu takes the first Escape', () => {
    renderSources();
    fireEvent.click(screen.getByRole('button', { name: /Searched for/ }));
    const card = cardOf('Supplier contract ACME');
    fireEvent.click(within(card).getByTitle('Actions'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(card).queryByText('Download')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the phone sheet is modal and keeps Tab inside it', () => {
    // No matchMedia in jsdom: the panel renders as the phone sheet.
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

  test('lists the cited sources at the end of the answer, not the ones only considered', () => {
    renderSources();
    const list = screen.getByRole('list', { name: 'Cited in this answer' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Langdock | The Platform for AI Adoption'),
      expect.stringContaining('Docs'),
      expect.stringContaining('Supplier contract ACME')
    ]);
    expect(within(list).queryByText('Langdock | Y Combinator')).not.toBeInTheDocument();
    expect(within(list).queryByText('Board minutes')).not.toBeInTheDocument();
    // Numbered like the badges; a page's title is its link, a document says where it lives.
    expect(within(rows[0]).getByRole('button', { name: /source 1/ })).toHaveTextContent('1');
    const link = within(rows[1]).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://docs.langdock.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(rows[2]).getByText('SharePoint')).toBeInTheDocument();
    // Nothing opens until asked.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test("a cited source's number opens the panel on its card; hover highlights its badges", () => {
    let open;
    function Probe() {
      open = useSourcesState().open;
      return null;
    }
    renderSources();
    render(<Probe />);
    const row = within(screen.getByRole('list', { name: 'Cited in this answer' }))
      .getByText('Docs')
      .closest('li');
    fireEvent.mouseEnter(row);
    expect(currentCitationHighlight()).toEqual({ messageKey: 'msg-1', n: 2 });
    fireEvent.mouseLeave(row);
    expect(currentCitationHighlight()).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: /source 2/ }));
    expect(open).toEqual({ messageKey: 'msg-1', focus: 2 });
    expect(screen.getByRole('dialog', { name: 'Sources' })).toBeInTheDocument();
  });

  test('a source without a link opens the panel from its title', () => {
    const items = [{ ...minutes, markers: ['r:1'] }];
    const content = 'See the minutes <cite type="r">1</cite>.';
    const set = { queries: [], items };
    const view = resolveCitations(content, set);
    render(<AnswerSources messageKey="msg-1" sources={set} citations={view} />);
    const list = screen.getByRole('list', { name: 'Cited in this answer' });
    expect(within(list).queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Board minutes' }));
    expect(screen.getByRole('dialog', { name: 'Sources' })).toBeInTheDocument();
  });

  test('a long list folds after five, and no list is shown while the answer streams', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `url:site${i}.example`,
      provider: 'web',
      kind: 'page',
      url: `https://site${i}.example/`,
      title: `Site ${i}`,
      private: false
    }));
    const content = many.map((source, i) => `Claim ${i} [${i + 1}](${source.url}).`).join(' ');
    const set = { queries: [], items: many };
    const view = resolveCitations(content, set);
    const { rerender } = render(
      <AnswerSources messageKey="msg-1" sources={set} citations={view} listCited={false} />
    );
    expect(screen.queryByRole('list', { name: 'Cited in this answer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sources.sourcesCount:7/ })).toBeInTheDocument();

    rerender(<AnswerSources messageKey="msg-1" sources={set} citations={view} />);
    const list = screen.getByRole('list', { name: 'Cited in this answer' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'sources.showMoreCited:2' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  test('an answer that found nothing shows no entry', () => {
    const empty = { items: [], queries: [] };
    const { container } = render(
      <AnswerSources messageKey="m" sources={empty} citations={resolveCitations('', empty)} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('labels the entry by what was searched, else by the number of sources', () => {
    const t = (key, fallback, options) =>
      typeof fallback === 'object' ? `${key}:${fallback.count}` : `${key}:${options?.query}`;
    expect(sourcesLabel(t, { queries: ['a'] })).toBe('sources.searchedFor:a');
    expect(sourcesLabel(t, { queries: ['a', 'b', 'c'] })).toBe('sources.searches:3');
    expect(sourcesLabel(t, { queries: [], items: [contract, minutes] })).toBe(
      'sources.sourcesCount:2'
    );
  });
});

describe('a reopened chat', () => {
  test('restores the sources of a stored answer; the badge is never inferred from them', () => {
    const message = transformStoredMessage({
      id: 'm1',
      role: 'assistant',
      content: answer,
      sources
    });
    expect(message.sources.queries).toEqual(['what is langdock']);
    expect(message.sources.items.map(item => item.id)).toEqual(sources.items.map(i => i.id));
    // The badge is the stored activity's: the server named the answer's sources.
    expect(message.answerSource).toBeUndefined();
    expect(resolveCitations(message.content, message.sources).cited).toHaveLength(3);
  });

  test('an answer without sources gets none; fields of the old contract are not read', () => {
    const message = transformStoredMessage({
      id: 'm2',
      role: 'assistant',
      content: 'x',
      citations: { references: [], resultItems: [{ document_id: 'd' }] },
      webSearch: { queries: ['q'], sources: [{ url: 'https://a.example/' }] }
    });
    expect(message.sources).toBeUndefined();
    expect(message.citations).toBeUndefined();
    expect(message.webSearch).toBeUndefined();
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
