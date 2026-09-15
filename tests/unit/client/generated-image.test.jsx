import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';

/**
 * A generated image, reopened — #2362.
 *
 * The picture reaches the chat bubble in two shapes and only one of them
 * carries pixels. Live, it is base64 off the run's stream and renders with no
 * request. Reopened from a durable chat, the message carries a descriptor —
 * `{ id, mimeType, bytes }` — and the bytes are fetched per image, which is
 * what keeps opening a chat that produced a dozen of them from shipping
 * megabytes before the first word appears.
 *
 * So there are three things to hold: hydration keeps the descriptors, the
 * component fetches a descriptor's bytes, and the "download it or you will
 * lose it" note appears only where it is still true.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => def || key })
}));

jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));

const mockFetchChatImage = jest.fn();
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchChatImage: (...args) => mockFetchChatImage(...args),
  sendAppChatMessage: jest.fn().mockResolvedValue({})
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-icon={name} />
}));

const GeneratedImage =
  require('../../../client/src/features/chat/components/GeneratedImage').default;
const useChatMessages = require('../../../client/src/features/chat/hooks/useChatMessages').default;

beforeEach(() => {
  mockFetchChatImage.mockReset();
  global.URL.createObjectURL = jest.fn(() => 'blob:stored-image');
  global.URL.revokeObjectURL = jest.fn();
});

describe('hydrating a stored chat', () => {
  it('keeps the image descriptors on the assistant message', () => {
    const { result } = renderHook(() => useChatMessages('chat-1', { serverBacked: true }));

    act(() => {
      result.current.loadServerMessages([
        { id: 'srv-1', role: 'user', content: 'draw me a cat' },
        {
          id: 'srv-2',
          role: 'assistant',
          content: 'here you go',
          images: [{ id: 'img-1', mimeType: 'image/png', bytes: 1024 }]
        }
      ]);
    });

    const answer = result.current.messages.at(-1);
    // The descriptor, not a payload: the transcript endpoint never ships one.
    expect(answer.images).toEqual([{ id: 'img-1', mimeType: 'image/png', bytes: 1024 }]);
  });
});

describe('rendering one image', () => {
  it('renders a live image from memory without asking the server', () => {
    render(
      <GeneratedImage image={{ mimeType: 'image/png', data: 'AAAA' }} chatId="chat-1" index={0} />
    );

    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(mockFetchChatImage).not.toHaveBeenCalled();
  });

  it('fetches the bytes of a stored image and renders them', async () => {
    mockFetchChatImage.mockResolvedValue(new Blob(['png bytes']));

    render(
      <GeneratedImage
        image={{ id: 'img-1', mimeType: 'image/png', bytes: 9 }}
        chatId="chat-1"
        index={0}
        persisted
      />
    );

    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:stored-image')
    );
    expect(mockFetchChatImage).toHaveBeenCalledWith('chat-1', 'img-1');
  });

  it('says so rather than showing a broken picture when the fetch fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchChatImage.mockRejectedValue(new Error('gone'));

    render(
      <GeneratedImage
        image={{ id: 'img-1', mimeType: 'image/png', bytes: 9 }}
        chatId="chat-1"
        index={0}
        persisted
      />
    );

    await waitFor(() => expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it('names the reason an image the server refused is missing', () => {
    // A viewer who watched the picture appear and came back to a gap needs to
    // be able to tell a dropped image from one the model never drew.
    render(
      <GeneratedImage
        image={{ mimeType: 'image/png', bytes: 40_000_000, unavailable: 'too-large' }}
        chatId="chat-1"
        index={0}
        persisted
      />
    );

    expect(screen.getByText(/larger than this installation stores/i)).toBeInTheDocument();
  });
});

describe('the "download it or lose it" note', () => {
  it('is shown where nothing stores the image', () => {
    render(
      <GeneratedImage image={{ mimeType: 'image/png', data: 'AAAA' }} chatId="chat-1" index={0} />
    );

    expect(screen.getByText(/not persisted when you navigate away/i)).toBeInTheDocument();
  });

  it('is gone in a chat that stores its images', () => {
    render(
      <GeneratedImage
        image={{ mimeType: 'image/png', data: 'AAAA' }}
        chatId="chat-1"
        index={0}
        persisted
      />
    );

    expect(screen.queryByText(/not persisted when you navigate away/i)).not.toBeInTheDocument();
  });
});
