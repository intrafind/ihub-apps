// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The URL and iFinder pickers of the project "Add item" dialog (#1036): a
 * slow URL check never reports on an earlier URL, Enter cannot start a
 * second iFinder search while one runs, and the item name follows the picked
 * iFinder document until the user types a name of their own.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useState } from 'react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The default text, as `t(key, default, values)` or, for plurals,
    // `t(key, {count, defaultValue_one, defaultValue_other, ...values})`.
    t: (key, def, options) => {
      const values = typeof def === 'object' && def ? def : options || {};
      const text =
        typeof def === 'string'
          ? def
          : values.count === 1
            ? values.defaultValue_one
            : values.defaultValue_other;
      if (typeof text !== 'string') return key;
      return Object.entries(values).reduce(
        (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
        text
      );
    },
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const {
  IFinderDocumentPicker,
  UrlPicker
} = require('../../../client/src/features/projects/components/item-dialog/ItemPickers');
const { comparableUrl } = require('../../../client/src/features/projects/utils/projectItems');

const errorMessage = err => err.message;

/** The dialog's draft, held in state the way `ItemFormBody` holds it. */
function WithDraft({ picker: Picker, initial, probe, ...props }) {
  const [draft, setDraft] = useState(initial);
  const update = changes => setDraft(prev => ({ ...prev, ...changes }));
  return (
    <>
      <Picker draft={draft} update={update} {...props} />
      <output data-testid="draft">{JSON.stringify(probe ? probe(draft) : draft)}</output>
      <input
        aria-label="Item name"
        value={draft.name || ''}
        onChange={e => update({ name: e.target.value })}
      />
    </>
  );
}

const draftOf = () => JSON.parse(screen.getByTestId('draft').textContent);

function deferred() {
  let resolve;
  const promise = new Promise(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('UrlPicker', () => {
  test('a slow check for an earlier URL does not report on the current one', async () => {
    const first = deferred();
    const second = deferred();
    const checkUrl = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://old.example' }}
        checkUrl={checkUrl}
        errorMessage={errorMessage}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://new.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(checkUrl).toHaveBeenLastCalledWith('https://new.example');

    // The earlier URL's answer arrives while the new check runs: dropped.
    await act(async () => {
      first.resolve({ ok: false, error: 'not found' });
    });
    expect(screen.queryByText(/cannot be read/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Checking...' })).toBeInTheDocument();

    await act(async () => {
      second.resolve({ ok: true });
    });
    expect(screen.getByText('The page can be read.')).toBeInTheDocument();
  });

  test('a check that answers after the URL was edited shows nothing', async () => {
    const pending = deferred();
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://old.example' }}
        checkUrl={() => pending.promise}
        errorMessage={errorMessage}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://new.example' } });
    await act(async () => {
      pending.resolve({ ok: true });
    });
    expect(screen.queryByText('The page can be read.')).toBeNull();
  });
});

describe('UrlPicker — preview and site crawl', () => {
  const CRAWL = {
    ok: true,
    truncated: false,
    pages: [
      { url: 'https://x.com/docs/', title: 'Docs', depth: 0, type: 'page' },
      { url: 'https://x.com/docs/a', title: 'Page A', depth: 1, type: 'page' },
      { url: 'https://x.com/docs/b.pdf', title: 'b.pdf', depth: 1, type: 'document' },
      { url: 'https://x.com/docs/old', title: 'Old page', depth: 1, type: 'page' }
    ]
  };

  test('shows the text a page gives the model before it is added', async () => {
    const previewUrl = jest.fn().mockResolvedValue({
      ok: true,
      title: 'Handbook',
      finalUrl: 'https://x.com/handbook',
      text: '# Handbook\n\nHello',
      chars: 18,
      truncated: true
    });
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/handbook' }}
        checkUrl={jest.fn()}
        previewUrl={previewUrl}
        errorMessage={errorMessage}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    });
    expect(previewUrl).toHaveBeenCalledWith('https://x.com/handbook');
    const panel = screen.getByTestId('url-preview');
    expect(panel).toHaveTextContent('Extracted content: Handbook');
    expect(panel).toHaveTextContent('# Handbook');
    expect(panel).toHaveTextContent('only this part is given to the model');

    fireEvent.click(screen.getByRole('button', { name: 'Close the preview' }));
    expect(screen.queryByTestId('url-preview')).toBeNull();
  });

  test('a failed preview says why', async () => {
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/missing' }}
        checkUrl={jest.fn()}
        previewUrl={() => Promise.reject(new Error('HTTP 404'))}
        errorMessage={errorMessage}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('The page cannot be read: HTTP 404');
  });

  const openCrawl = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Find more pages of this website' }));

  test('keeps the site search folded away until it is opened', () => {
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/docs/', selectedUrls: [] }}
        checkUrl={jest.fn()}
        crawlUrl={jest.fn()}
        errorMessage={errorMessage}
      />
    );
    const toggle = screen.getByRole('button', { name: 'Find more pages of this website' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Find pages' })).toBeNull();
    openCrawl();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Find pages' })).toBeInTheDocument();
  });

  test('lists the pages of a site and puts the ticked ones into the draft', async () => {
    const crawlUrl = jest.fn().mockResolvedValue({
      ...CRAWL,
      scope: { origin: 'https://x.com', path: '/docs/' },
      robotsExcluded: 2
    });
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/docs/', selectedUrls: [] }}
        checkUrl={jest.fn()}
        crawlUrl={crawlUrl}
        // Written differently from the crawl's address: a trailing slash, a fragment.
        existingUrls={new Set([comparableUrl('https://X.com/docs/old/#top')])}
        errorMessage={errorMessage}
        probe={draft => draft.selectedUrls}
      />
    );
    openCrawl();
    fireEvent.change(screen.getByLabelText('Link depth'), { target: { value: '3' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find pages' }));
    });
    expect(crawlUrl).toHaveBeenCalledWith('https://x.com/docs/', {
      maxPages: 50,
      maxDepth: 3,
      samePath: true
    });
    expect(screen.getByTestId('crawl-status')).toHaveTextContent(
      '0 of 4 pages selected · 1 already added'
    );
    expect(screen.getByText(/Searched https:\/\/x\.com\/docs\/…/)).toHaveTextContent(
      '2 links were left out because the website excludes them in its robots.txt.'
    );

    // A page the project has already cannot be picked again.
    const old = screen.getByRole('checkbox', { name: /Old page/ });
    expect(old).toBeDisabled();
    expect(old).toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: /Page A/ }));
    expect(draftOf()).toEqual([{ url: 'https://x.com/docs/a', title: 'Page A' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(draftOf().map(page => page.url)).toEqual([
      'https://x.com/docs/a',
      'https://x.com/docs/',
      'https://x.com/docs/b.pdf'
    ]);

    // The filter narrows what "Select none" clears.
    fireEvent.change(screen.getByLabelText('Filter pages'), { target: { value: 'pdf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect(draftOf().map(page => page.url)).toEqual([
      'https://x.com/docs/a',
      'https://x.com/docs/'
    ]);

    // Another address: the list and the picks go.
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://y.com/' } });
    expect(draftOf()).toEqual([]);
    expect(screen.queryByTestId('crawl-results')).toBeNull();
  });

  test('a crawl that answers after the URL was edited lists nothing', async () => {
    const pending = deferred();
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/docs/', selectedUrls: [] }}
        checkUrl={jest.fn()}
        crawlUrl={() => pending.promise}
        errorMessage={errorMessage}
      />
    );
    openCrawl();
    fireEvent.click(screen.getByRole('button', { name: 'Find pages' }));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://y.com/' } });
    await act(async () => {
      pending.resolve(CRAWL);
    });
    expect(screen.queryByTestId('crawl-results')).toBeNull();
  });

  test('a failed crawl says why', async () => {
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/docs/', selectedUrls: [] }}
        checkUrl={jest.fn()}
        crawlUrl={jest.fn().mockResolvedValue({ ok: false, error: 'HTTP 503' })}
        errorMessage={errorMessage}
      />
    );
    openCrawl();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find pages' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('The website cannot be read: HTTP 503');
  });

  test('no more pages can be ticked than the project takes', async () => {
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/docs/', selectedUrls: [] }}
        checkUrl={jest.fn()}
        crawlUrl={jest.fn().mockResolvedValue(CRAWL)}
        remaining={2}
        errorMessage={errorMessage}
        probe={draft => draft.selectedUrls.map(page => page.url)}
      />
    );
    openCrawl();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find pages' }));
    });
    expect(screen.getByTestId('crawl-status')).toHaveTextContent('2 more fit into the project');

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(draftOf()).toEqual(['https://x.com/docs/', 'https://x.com/docs/a']);
    expect(screen.getByTestId('crawl-status')).toHaveTextContent('0 more fit into the project');
    expect(screen.getByText(/The project takes no more pages/)).toBeInTheDocument();
    // The rest cannot be ticked; a ticked one can still be unticked.
    expect(screen.getByRole('checkbox', { name: /Old page/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Page A/ }));
    expect(draftOf()).toEqual(['https://x.com/docs/']);
  });

  test('a page of the list can be previewed, and the focus comes back to it', async () => {
    const previewUrl = jest.fn().mockResolvedValue({ ok: true, text: 'A text', chars: 1 });
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/docs/', selectedUrls: [] }}
        checkUrl={jest.fn()}
        previewUrl={previewUrl}
        crawlUrl={jest.fn().mockResolvedValue(CRAWL)}
        errorMessage={errorMessage}
      />
    );
    openCrawl();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find pages' }));
    });
    const eye = screen.getByRole('button', { name: 'Preview Page A' });
    eye.focus();
    await act(async () => {
      fireEvent.click(eye);
    });
    expect(previewUrl).toHaveBeenCalledWith('https://x.com/docs/a');
    const panel = screen.getByTestId('url-preview');
    expect(panel).toHaveTextContent('Extracted content: Page A');
    expect(panel).toHaveTextContent('1 character');
    // The panel takes the focus, and its text can be scrolled by keyboard.
    expect(panel).toHaveFocus();
    expect(screen.getByLabelText('Text of Page A')).toHaveAttribute('tabindex', '0');

    fireEvent.click(screen.getByRole('button', { name: 'Close the preview' }));
    expect(eye).toHaveFocus();
  });

  test('nothing can be ticked while the picked pages are being added', async () => {
    render(
      <WithDraft
        picker={UrlPicker}
        initial={{ url: 'https://x.com/docs/', selectedUrls: [] }}
        checkUrl={jest.fn()}
        crawlUrl={jest.fn().mockResolvedValue(CRAWL)}
        busy
        errorMessage={errorMessage}
      />
    );
    openCrawl();
    expect(screen.getByRole('button', { name: 'Find pages' })).toBeDisabled();
  });
});

describe('IFinderDocumentPicker', () => {
  const RESULTS = [
    { documentId: 'd1', title: 'Lease agreement' },
    { documentId: 'd2', title: 'Notice letter' }
  ];

  test('Enter does not start a second search while one runs', async () => {
    const pending = deferred();
    const searchIFinder = jest.fn(() => pending.promise);
    render(
      <WithDraft
        picker={IFinderDocumentPicker}
        initial={{ documentId: '', documentTitle: '', name: '' }}
        searchIFinder={searchIFinder}
        errorMessage={errorMessage}
      />
    );
    const field = screen.getByLabelText('Search iFinder');
    fireEvent.change(field, { target: { value: 'lease' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(searchIFinder).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(RESULTS);
    });
    expect(screen.getByText('Lease agreement')).toBeInTheDocument();
  });

  async function searchAndShow() {
    render(
      <WithDraft
        picker={IFinderDocumentPicker}
        initial={{ documentId: '', documentTitle: '', name: '' }}
        searchIFinder={() => Promise.resolve(RESULTS)}
        errorMessage={errorMessage}
      />
    );
    const field = screen.getByLabelText('Search iFinder');
    fireEvent.change(field, { target: { value: 'lease' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
  }

  test('the name follows the picked document until the user types their own', async () => {
    await searchAndShow();
    fireEvent.click(screen.getByText('Lease agreement'));
    expect(draftOf()).toMatchObject({ documentId: 'd1', name: 'Lease agreement' });

    // Another pick: the name was taken from the first document, so it follows.
    fireEvent.click(screen.getByText('Notice letter'));
    expect(draftOf()).toMatchObject({ documentId: 'd2', name: 'Notice letter' });

    // A name of the user's own stays through the next pick.
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Our lease' } });
    fireEvent.click(screen.getByText('Lease agreement'));
    expect(draftOf()).toMatchObject({ documentId: 'd1', name: 'Our lease' });
  });
});
