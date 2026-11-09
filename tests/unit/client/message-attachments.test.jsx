// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The files of a sent message, shown as a block of their own above the bubble.
 *
 * One list, one card per file; a card is a button only when there is a stored file to open;
 * what the assistant got from a file stays on the card after Send; more cards than fit fold
 * into "+N more files" and never into "+1".
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '');
    }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const MessageAttachments =
  require('../../../client/src/features/chat/components/MessageAttachments').default;
const { visibleCount } = require('../../../client/src/features/chat/components/MessageAttachments');
const {
  toAttachmentViews
} = require('../../../client/src/features/chat/messageAttachments/attachmentViews');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const stored = (id, name, extra = {}) => ({
  id,
  type: 'application/pdf',
  name,
  bytes: 2400000,
  hasOriginal: true,
  ...extra
});
const viewsOf = descriptors => toAttachmentViews({ stored: descriptors });
const docs = count =>
  viewsOf(Array.from({ length: count }, (_, i) => stored(`f${i + 1}`, `doc-${i + 1}.pdf`)));

describe('visibleCount', () => {
  test('everything fits up to the cap; beyond it one slot goes to the fold, so it never says +1', () => {
    expect(visibleCount(3, 4)).toBe(3);
    expect(visibleCount(4, 4)).toBe(4);
    expect(visibleCount(5, 4)).toBe(3);
    expect(visibleCount(6, 4)).toBe(3);
    for (let n = 1; n <= 30; n += 1) {
      for (const cap of [3, 4, 6]) {
        const hidden = n - visibleCount(n, cap);
        expect(hidden).not.toBe(1);
      }
    }
  });
});

describe('MessageAttachments: structure', () => {
  test('nothing attached renders nothing', () => {
    const { container } = render(<MessageAttachments attachments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('one labelled list with one item per file, naming the file, its type and its size', () => {
    render(<MessageAttachments attachments={viewsOf([stored('f1', 'Contract.pdf')])} />);
    const list = screen.getByRole('list', { name: 'Attachments' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Contract.pdf');
    expect(items[0]).toHaveTextContent('PDF');
    expect(items[0]).toHaveTextContent('2.3 MB');
  });

  test('a stored file is a button that opens it in the Files drawer', () => {
    const onOpenFile = jest.fn();
    render(
      <MessageAttachments
        attachments={viewsOf([stored('f1', 'Contract.pdf')])}
        onOpenFile={onOpenFile}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Contract\.pdf/ }));
    expect(onOpenFile).toHaveBeenCalledWith('f1');
  });

  test('the button says what it does, once, through the description', () => {
    render(
      <MessageAttachments
        attachments={viewsOf([stored('f1', 'Contract.pdf')])}
        onOpenFile={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: /Contract\.pdf/ })).toHaveAccessibleDescription(
      'Opens in the Files panel'
    );
  });

  test('without a drawer (no onOpenFile) or without an id the card is plain: no button, no tab stop', () => {
    const { rerender } = render(
      <MessageAttachments attachments={viewsOf([stored('f1', 'Contract.pdf')])} />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(
      <MessageAttachments
        attachments={viewsOf([{ type: 'application/pdf', name: 'inline.pdf', bytes: 10 }])}
        onOpenFile={() => {}}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('inline.pdf')).toBeInTheDocument();
  });

  test('a shared file the viewer may not open says so and is not a button', () => {
    render(
      <MessageAttachments
        attachments={viewsOf([stored('f1', 'Private.pdf', { shared: false })])}
        onOpenFile={() => {}}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Not shared by the owner')).toBeInTheDocument();
  });

  test('a shared file the viewer may open is a button', () => {
    const onOpenFile = jest.fn();
    render(
      <MessageAttachments
        attachments={viewsOf([stored('f1', 'Open.pdf', { shared: true })])}
        onOpenFile={onOpenFile}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Open\.pdf/ }));
    expect(onOpenFile).toHaveBeenCalledWith('f1');
  });

  test('a file without a name gets a fallback, not an empty card', () => {
    render(<MessageAttachments attachments={viewsOf([{ type: 'text/plain', bytes: 5 }])} />);
    expect(screen.getByTestId('message-attachment')).toHaveTextContent('file');
  });
});

describe('MessageAttachments: nothing from a file name or a preview becomes markup', () => {
  test('a name that looks like HTML is shown as text and creates no element', () => {
    const name = '<img src=x onerror=alert(1)>.pdf';
    const { container } = render(
      <MessageAttachments attachments={viewsOf([stored('f1', name)])} />
    );
    expect(screen.getByText(name)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  test('a live image gets a decorative thumbnail; the name carries the meaning', () => {
    const views = toAttachmentViews({
      live: {
        imageData: { type: 'image', fileName: 'scan.png', fileType: 'image/png', base64: PNG }
      }
    });
    const { container } = render(<MessageAttachments attachments={views} />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', PNG);
    expect(img).toHaveAttribute('alt', '');
    expect(screen.getByTestId('message-attachment')).toHaveTextContent('scan.png');
  });

  test('an image after a reload has no thumbnail, only its named tile', () => {
    const { container } = render(
      <MessageAttachments
        attachments={viewsOf([{ type: 'image/png', name: 'scan.png', bytes: 5 }])}
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('message-attachment')).toHaveTextContent('scan.png');
  });
});

describe('MessageAttachments: what the assistant got survives Send', () => {
  test('a document sent in this session says how much text was read', () => {
    const views = toAttachmentViews({
      live: {
        fileData: {
          type: 'document',
          fileName: 'Contract.pdf',
          fileSize: 2400000,
          fileType: 'application/pdf',
          content: 'x'.repeat(12400)
        }
      }
    });
    render(<MessageAttachments attachments={views} />);
    expect(screen.getByText(/Text extracted: 12.?400 characters/)).toBeInTheDocument();
  });

  test('a scan, a shortened text and an unreadable file say so, in the composer words', () => {
    const base = { type: 'document', fileType: 'application/pdf', fileSize: 10 };
    const views = toAttachmentViews({
      live: {
        fileData: [
          { ...base, fileName: 'scan.pdf', content: '', pageImages: ['a', 'b', 'c'] },
          { ...base, fileName: 'long.pdf', content: 'y'.repeat(50), truncated: true },
          { ...base, fileName: 'empty.pdf', content: '' }
        ]
      }
    });
    render(<MessageAttachments attachments={views} />);
    expect(screen.getByText('scan without text: 3 page image(s) sent instead')).toBeInTheDocument();
    expect(screen.getByText(/shortened to fit/)).toBeInTheDocument();
    expect(screen.getByText('No text could be read from this file')).toBeInTheDocument();
  });

  test('a file that could not be saved to the chat says it went with the message only', () => {
    const views = toAttachmentViews({
      live: {
        fileData: {
          type: 'document',
          fileName: 'big.pdf',
          fileType: 'application/pdf',
          content: 'z',
          uploadState: 'error',
          uploadError: 'QUOTA_CHAT_FILES'
        }
      }
    });
    render(<MessageAttachments attachments={views} />);
    expect(
      screen.getByText('Not saved to the chat · sent with this message only')
    ).toBeInTheDocument();
  });

  test('once only the text is kept the card says so and shows no file size', () => {
    render(
      <MessageAttachments
        attachments={viewsOf([stored('f1', 'Old.pdf', { hasOriginal: false, bytes: 41000 })])}
      />
    );
    const card = screen.getByTestId('message-attachment');
    expect(card).toHaveTextContent('Text only');
    expect(card).not.toHaveTextContent('KB');
    expect(card).not.toHaveTextContent('MB');
  });

  test('a reopened document says nothing extra: nothing is known beyond its descriptor', () => {
    render(<MessageAttachments attachments={viewsOf([stored('f1', 'Plain.pdf')])} />);
    const card = screen.getByTestId('message-attachment');
    expect(card).not.toHaveTextContent('Text extracted');
    expect(card).not.toHaveTextContent('No text could be read');
  });
});

describe('MessageAttachments: more files than fit', () => {
  test('up to four files on a wide surface show all, with no fold', () => {
    render(<MessageAttachments attachments={docs(4)} />);
    expect(screen.getAllByTestId('message-attachment')).toHaveLength(4);
    expect(screen.queryByTestId('message-attachments-fold')).not.toBeInTheDocument();
  });

  test('five files show three and fold two; expanding shows all and offers to fold again', () => {
    render(<MessageAttachments attachments={docs(5)} />);
    expect(screen.getAllByTestId('message-attachment')).toHaveLength(3);
    const fold = screen.getByTestId('message-attachments-fold');
    expect(fold).toHaveTextContent('+2 more files');
    expect(fold).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(fold);
    expect(screen.getAllByTestId('message-attachment')).toHaveLength(5);
    expect(screen.getByTestId('message-attachments-fold')).toHaveTextContent('Show fewer');
    expect(screen.getByTestId('message-attachments-fold')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('2 more files shown')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('message-attachments-fold'));
    expect(screen.getAllByTestId('message-attachment')).toHaveLength(3);
  });

  test('a narrow surface folds one card earlier: four files show two', () => {
    render(<MessageAttachments attachments={docs(4)} compact />);
    expect(screen.getAllByTestId('message-attachment')).toHaveLength(2);
    expect(screen.getByTestId('message-attachments-fold')).toHaveTextContent('+2 more files');
  });

  test('expanding moves focus to the first card that was folded away; folding returns to the button', () => {
    render(<MessageAttachments attachments={docs(5)} onOpenFile={() => {}} />);
    fireEvent.click(screen.getByTestId('message-attachments-fold'));
    expect(screen.getByRole('button', { name: /doc-4\.pdf/ })).toHaveFocus();
    fireEvent.click(screen.getByTestId('message-attachments-fold'));
    expect(screen.getByTestId('message-attachments-fold')).toHaveFocus();
  });

  test('two images are rows, three or more are a labelled grid', () => {
    const image = i => ({ type: 'image/png', name: `img-${i}.png`, bytes: 5 });
    const { rerender } = render(<MessageAttachments attachments={viewsOf([image(1), image(2)])} />);
    expect(screen.queryByRole('list', { name: 'Images' })).not.toBeInTheDocument();
    rerender(<MessageAttachments attachments={viewsOf([image(1), image(2), image(3)])} />);
    const grid = screen.getByRole('list', { name: 'Images' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(3);
  });

  test('images fold on their own cap: seven on a wide surface show five', () => {
    const images = Array.from({ length: 7 }, (_, i) => ({
      type: 'image/png',
      name: `img-${i + 1}.png`,
      bytes: 5
    }));
    render(<MessageAttachments attachments={viewsOf(images)} />);
    expect(screen.getAllByTestId('message-attachment')).toHaveLength(5);
    expect(screen.getByTestId('message-attachments-fold')).toHaveTextContent('+2 more files');
  });
});

describe('MessageAttachments: what a screen reader is told', () => {
  const imagesWithLines = () =>
    toAttachmentViews({
      live: {
        imageData: [1, 2, 3].map(n => ({
          type: 'image',
          fileName: `photo-${n}.png`,
          fileType: 'image/png',
          fileSize: 1000,
          width: 640,
          height: 480
        }))
      }
    });

  test('every id a card is described by exists, also for the tiles of an image grid', () => {
    const { container } = render(<MessageAttachments attachments={imagesWithLines()} />);
    const tiles = screen.getAllByTestId('message-attachment');
    expect(tiles).toHaveLength(3);
    for (const tile of tiles) {
      for (const id of (tile.getAttribute('aria-describedby') || '').split(' ').filter(Boolean)) {
        expect(container.querySelector(`[id="${CSS.escape(id)}"]`)).not.toBeNull();
      }
    }
  });

  test('a grid tile has no room for its state line, so its text carries it', () => {
    render(<MessageAttachments attachments={imagesWithLines()} />);
    const [tile] = screen.getAllByTestId('message-attachment');
    expect(tile).toHaveTextContent('Image sent to the model as 640×480');
  });

  test('"Opens in the Files panel" is there only when some card can open', () => {
    const views = viewsOf([stored('f1', 'Contract.pdf')]);
    const { rerender } = render(<MessageAttachments attachments={views} />);
    expect(screen.queryByText('Opens in the Files panel')).not.toBeInTheDocument();
    rerender(<MessageAttachments attachments={views} onOpenFile={() => {}} />);
    expect(screen.getByText('Opens in the Files panel')).toBeInTheDocument();
    // a stored file that is not shared with this viewer cannot open either
    rerender(
      <MessageAttachments
        attachments={viewsOf([stored('f1', 'Contract.pdf', { shared: false })])}
        onOpenFile={() => {}}
      />
    );
    expect(screen.queryByText('Opens in the Files panel')).not.toBeInTheDocument();
  });
});

describe('MessageAttachments: the look of a card', () => {
  const tileOf = card => card.querySelector('span[aria-hidden="true"]');

  test('a PDF is red; a type nobody has a look for is neutral, not the PDF red', () => {
    render(
      <MessageAttachments
        attachments={viewsOf([
          { type: 'application/pdf', name: 'a.pdf', bytes: 10 },
          { type: 'application/x-unknown', name: 'b.bin', bytes: 10 }
        ])}
      />
    );
    const [pdf, other] = screen.getAllByTestId('message-attachment');
    expect(tileOf(pdf).className).toContain('bg-red-50');
    expect(tileOf(other).className).not.toContain('bg-red-50');
    expect(tileOf(other).className).toContain('bg-gray-100');
  });
});

describe('MessageAttachments: after a reload, what the server recorded', () => {
  test('says what the assistant got from a stored document', () => {
    render(
      <MessageAttachments
        attachments={viewsOf([stored('f1', 'Contract.pdf', { textBytes: 12400 })])}
      />
    );
    expect(screen.getByText('Text extracted on the server: 12.1 KB')).toBeInTheDocument();
  });

  test('says a scan went as page images, and that a text was shortened', () => {
    render(
      <MessageAttachments
        attachments={viewsOf([
          stored('f1', 'scan.pdf', { textBytes: 900, pageImageCount: 3 }),
          stored('f2', 'long.pdf', { textBytes: 48000, truncated: true })
        ])}
      />
    );
    expect(screen.getByText('scan without text: 3 page image(s) sent instead')).toBeInTheDocument();
    expect(screen.getByText(/shortened to fit/)).toBeInTheDocument();
  });

  test('says an image and a sound file were sent to the model', () => {
    render(
      <MessageAttachments
        attachments={viewsOf([
          { type: 'image/png', name: 'a.png', bytes: 5 },
          { type: 'audio/mpeg', name: 'a.mp3', bytes: 5 }
        ])}
      />
    );
    expect(screen.getByText('Image sent to the model')).toBeInTheDocument();
    expect(screen.getByText('Audio sent to the model')).toBeInTheDocument();
  });

  test('a text-only file shows no file size: the number would be that of the text, not the file', () => {
    // `bytes` is 2.3 MB in the descriptor; the text is 40 KB
    render(
      <MessageAttachments
        attachments={viewsOf([
          stored('f1', 'Old.pdf', { hasOriginal: undefined, textBytes: 41000 })
        ])}
      />
    );
    const card = screen.getByTestId('message-attachment');
    expect(card).not.toHaveTextContent('2.3 MB');
    expect(card).toHaveTextContent('only the text is kept in this chat');
  });
});

describe('MessageAttachments: the picture of a stored image', () => {
  const picture = (id, name, extra = {}) => ({
    id,
    type: 'image/png',
    name,
    bytes: 5000,
    hasOriginal: true,
    origin: 'image',
    ...extra
  });
  const blob = new Blob(['x'], { type: 'image/png' });
  let observers;

  beforeEach(() => {
    observers = [];
    URL.createObjectURL = jest.fn(() => 'blob:picture-1');
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    delete global.IntersectionObserver;
  });

  /** An IntersectionObserver that reports a card as visible only when the test says so. */
  const lazyObserver = () => {
    global.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observed = [];
        observers.push(this);
      }
      observe(node) {
        this.observed.push(node);
      }
      disconnect() {}
    };
  };
  const scrollIntoView = () =>
    act(() => {
      for (const observer of observers) observer.callback([{ isIntersecting: true }]);
    });

  test('a picture read back from the store shows its thumbnail, fetched by its id', async () => {
    const fetchFileBlob = jest.fn(() => Promise.resolve(blob));
    render(
      <MessageAttachments
        attachments={viewsOf([picture('file_img', 'whiteboard.png')])}
        fetchFileBlob={fetchFileBlob}
      />
    );
    const card = screen.getByTestId('message-attachment');
    await waitFor(() => expect(card.querySelector('img')).not.toBeNull());
    expect(fetchFileBlob).toHaveBeenCalledTimes(1);
    expect(fetchFileBlob).toHaveBeenCalledWith('file_img');
    expect(card.querySelector('img')).toHaveAttribute('src', 'blob:picture-1');
    expect(card.querySelector('img')).toHaveAttribute('alt', '');
  });

  test('a picture a regenerated turn did not send again does not say it was sent', async () => {
    const fetchFileBlob = jest.fn(() => Promise.resolve(blob));
    render(
      <MessageAttachments
        attachments={viewsOf([
          picture('file_img', 'sent.png'),
          picture('file_img2', 'again.png', { sentToModel: false })
        ])}
        fetchFileBlob={fetchFileBlob}
      />
    );
    const cards = screen.getAllByTestId('message-attachment');
    expect(cards[0]).toHaveTextContent('Image sent to the model');
    expect(cards[1]).toHaveTextContent('again.png');
    expect(cards[1]).not.toHaveTextContent('sent to the model');
    // Its thumbnail still comes from the store: the picture is there, it just was not sent
    await waitFor(() => expect(fetchFileBlob).toHaveBeenCalledWith('file_img2'));
  });

  test('a picture still in memory is not fetched', () => {
    const fetchFileBlob = jest.fn(() => Promise.resolve(blob));
    const [view] = viewsOf([picture('file_img', 'a.png')]);
    render(
      <MessageAttachments
        attachments={[{ ...view, previewSrc: PNG }]}
        fetchFileBlob={fetchFileBlob}
      />
    );
    expect(screen.getByTestId('message-attachment').querySelector('img')).toHaveAttribute(
      'src',
      PNG
    );
    expect(fetchFileBlob).not.toHaveBeenCalled();
  });

  test('nothing is fetched without a way to fetch, for a picture without an id, or a file not shared', () => {
    const fetchFileBlob = jest.fn(() => Promise.resolve(blob));
    const { rerender } = render(
      <MessageAttachments attachments={viewsOf([picture('file_img', 'a.png')])} />
    );
    rerender(
      <MessageAttachments
        attachments={viewsOf([{ type: 'image/png', name: 'b.png' }])}
        fetchFileBlob={fetchFileBlob}
      />
    );
    rerender(
      <MessageAttachments
        attachments={viewsOf([picture('file_img', 'c.png', { shared: false })])}
        fetchFileBlob={fetchFileBlob}
      />
    );
    expect(fetchFileBlob).not.toHaveBeenCalled();
  });

  test('a document is never fetched for a thumbnail', () => {
    const fetchFileBlob = jest.fn(() => Promise.resolve(blob));
    render(
      <MessageAttachments
        attachments={viewsOf([stored('f1', 'a.pdf')])}
        fetchFileBlob={fetchFileBlob}
      />
    );
    expect(fetchFileBlob).not.toHaveBeenCalled();
  });

  test('a picture that cannot be loaded keeps its tile and stays a card of the message', async () => {
    const fetchFileBlob = jest.fn(() => Promise.reject(new Error('gone')));
    render(
      <MessageAttachments
        attachments={viewsOf([picture('file_img', 'whiteboard.png')])}
        fetchFileBlob={fetchFileBlob}
      />
    );
    await waitFor(() => expect(fetchFileBlob).toHaveBeenCalled());
    const card = screen.getByTestId('message-attachment');
    expect(card.querySelector('img')).toBeNull();
    expect(card).toHaveTextContent('whiteboard.png');
  });

  test('a card waits until it is near the viewport', async () => {
    lazyObserver();
    const fetchFileBlob = jest.fn(() => Promise.resolve(blob));
    render(
      <MessageAttachments
        attachments={viewsOf([picture('file_img', 'whiteboard.png')])}
        fetchFileBlob={fetchFileBlob}
      />
    );
    expect(fetchFileBlob).not.toHaveBeenCalled();
    expect(observers).toHaveLength(1);
    scrollIntoView();
    await waitFor(() => expect(fetchFileBlob).toHaveBeenCalledWith('file_img'));
  });

  test('the object URL is released when the card goes away', async () => {
    const fetchFileBlob = jest.fn(() => Promise.resolve(blob));
    const { unmount } = render(
      <MessageAttachments
        attachments={viewsOf([picture('file_img', 'whiteboard.png')])}
        fetchFileBlob={fetchFileBlob}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('message-attachment').querySelector('img')).not.toBeNull()
    );
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:picture-1');
  });

  test('a tile of an image grid fetches its own picture', async () => {
    const fetchFileBlob = jest.fn(() => Promise.resolve(blob));
    render(
      <MessageAttachments
        attachments={viewsOf([1, 2, 3].map(n => picture(`file_${n}`, `p${n}.png`)))}
        fetchFileBlob={fetchFileBlob}
      />
    );
    await waitFor(() => expect(fetchFileBlob).toHaveBeenCalledTimes(3));
    expect(fetchFileBlob.mock.calls.map(call => call[0]).sort()).toEqual([
      'file_1',
      'file_2',
      'file_3'
    ]);
  });
});
