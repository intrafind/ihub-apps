// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The URL tab of the project "Add item" dialog with pages picked from a site
 * crawl: each picked page is added as its own URL item, named after its
 * title, and a page that fails stays picked so Add retries only it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, def, options) =>
      typeof def === 'string'
        ? Object.entries(options || {}).reduce(
            (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
            def
          )
        : key,
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const ItemFormBody =
  require('../../../client/src/features/projects/components/item-dialog/ItemFormBody').default;

const TAB = { id: 'url', kind: 'url', enabled: true, reason: null };
const CRAWL = {
  ok: true,
  pages: [
    { url: 'https://x.com/', title: 'Home', depth: 0, type: 'page' },
    { url: 'https://x.com/a', title: 'Page A', depth: 1, type: 'page' },
    { url: 'https://x.com/b', title: '', depth: 1, type: 'page' }
  ]
};

function renderForm(api, props = {}) {
  const onAdded = jest.fn();
  const onClose = jest.fn();
  render(
    <ItemFormBody
      tab={TAB}
      projectId="p1"
      config={null}
      api={api}
      multipleUploads={false}
      usage={null}
      onAdded={onAdded}
      onClose={onClose}
      {...props}
    />
  );
  return { onAdded, onClose };
}

async function crawlAndPickAll() {
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://x.com/' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Find pages' }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
}

test('adds every picked page as its own URL item', async () => {
  const addItem = jest.fn(async (projectId, body) => ({ id: body.ref.url }));
  const api = {
    addItem,
    checkUrl: jest.fn(),
    crawlUrl: jest.fn().mockResolvedValue(CRAWL),
    errorMessage: err => err.message
  };
  const { onAdded, onClose } = renderForm(api);
  await crawlAndPickAll();

  // Each page is named after itself: no shared name field.
  expect(screen.queryByLabelText('Name')).toBeNull();
  fireEvent.click(screen.getByLabelText('Pinned (always in the prompt)'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 pages' }));
  });

  expect(addItem.mock.calls.map(([, body]) => body)).toEqual([
    { kind: 'url', ref: { url: 'https://x.com/' }, name: 'Home', pinned: true },
    { kind: 'url', ref: { url: 'https://x.com/a' }, name: 'Page A', pinned: true },
    { kind: 'url', ref: { url: 'https://x.com/b' }, pinned: true }
  ]);
  expect(onAdded).toHaveBeenCalledTimes(3);
  expect(onClose).toHaveBeenCalled();
});

test('a page that fails stays picked and is the only one retried', async () => {
  const addItem = jest.fn(async (projectId, body) => {
    if (body.ref.url === 'https://x.com/a') throw new Error('quota');
    return { id: body.ref.url };
  });
  const api = {
    addItem,
    checkUrl: jest.fn(),
    crawlUrl: jest.fn().mockResolvedValue(CRAWL),
    errorMessage: err => err.message
  };
  const { onClose } = renderForm(api);
  await crawlAndPickAll();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 pages' }));
  });

  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Page A: quota');
  expect(screen.getByRole('button', { name: 'Add 1 pages' })).toBeInTheDocument();

  addItem.mockClear();
  addItem.mockResolvedValue({ id: 'a' });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 pages' }));
  });
  expect(addItem).toHaveBeenCalledTimes(1);
  expect(addItem.mock.calls[0][1].ref.url).toBe('https://x.com/a');
  expect(onClose).toHaveBeenCalled();
});

test('the project item quota is checked before anything is sent', async () => {
  const addItem = jest.fn();
  const api = {
    addItem,
    checkUrl: jest.fn(),
    crawlUrl: jest.fn().mockResolvedValue(CRAWL),
    errorMessage: err => err.message
  };
  renderForm(api, { config: { limits: { maxFiles: 4 } }, usage: { items: 2 } });
  await crawlAndPickAll();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 pages' }));
  });
  expect(addItem).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('A project holds at most 4 items');
});
