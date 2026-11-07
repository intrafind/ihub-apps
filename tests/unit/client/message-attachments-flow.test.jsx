// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A sent message and its files, from the composer to the bubble.
 *
 * The message's content is the text that was typed; the files are `attachments`, drawn as a
 * block above the bubble; the payload (`imageData` / `fileData` / `audioData`) stays on the
 * message for resending and for the context estimate. Images and audio travel exactly as before.
 */

import { act, render, renderHook, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessageList from '../../../client/src/features/chat/components/ChatMessageList';
import useChatMessages, {
  transformStoredMessage
} from '../../../client/src/features/chat/hooks/useChatMessages';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '');
    },
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { featuresMap: {} } })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));
jest.mock('../../../client/src/api', () => ({
  sendMessageFeedback: jest.fn(),
  answerInteraction: jest.fn()
}));
jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="content">{content}</div>
}));
jest.mock('../../../client/src/shared/components/CustomResponseRenderer', () => ({
  __esModule: true,
  default: () => <div data-testid="custom-renderer" />
}));
jest.mock('../../../client/src/shared/components/StarRating', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
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

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const image = {
  type: 'image',
  fileName: 'whiteboard.png',
  fileType: 'image/png',
  fileSize: 4200,
  base64: PNG,
  width: 640,
  height: 480
};
const audio = {
  type: 'audio',
  fileName: 'memo.mp3',
  fileType: 'audio/mpeg',
  fileSize: 90000,
  base64: 'data:audio/mpeg;base64,AAAA'
};
const doc = {
  type: 'document',
  fileName: 'Contract.pdf',
  fileType: 'application/pdf',
  fileSize: 2400000,
  content: 'x'.repeat(500)
};

function sentMessage(text, payload) {
  const { result } = renderHook(() => useChatMessages());
  act(() => {
    result.current.addUserMessage(text, { rawContent: text, ...payload });
  });
  return result.current.messages[0];
}

function renderMessages(messages) {
  return render(
    <ChatMessageList
      messages={messages}
      appId="app"
      chatId="chat-1"
      modelId="m"
      app={{ id: 'app' }}
    />
  );
}

describe('a turn sent in this session', () => {
  test('the content is the typed text; the files are attachments; the payload is kept for resending', () => {
    const message = sentMessage('Please check these', {
      imageData: image,
      audioData: audio,
      fileData: doc
    });
    expect(message.content).toBe('Please check these');
    expect(message.content).not.toMatch(/<|data:image|📎|🎵/);
    expect(message.attachments.map(view => [view.kind, view.name])).toEqual([
      ['document', 'Contract.pdf'],
      ['image', 'whiteboard.png'],
      ['audio', 'memo.mp3']
    ]);
    expect(message.imageData).toBe(image);
    expect(message.audioData).toBe(audio);
    expect(message.fileData).toBe(doc);
  });

  test('a message without files has no attachments', () => {
    const message = sentMessage('Just a question', {});
    expect(message.attachments).toBeUndefined();
  });

  test('images and audio show up as cards: the image with its thumbnail, the audio saying it was sent', () => {
    const message = sentMessage('Look at this', { imageData: image, audioData: audio });
    const { container } = renderMessages([message]);
    const list = screen.getByRole('list', { name: 'Attachments' });
    const cards = within(list).getAllByTestId('message-attachment');
    expect(cards.map(card => card.dataset.kind)).toEqual(['image', 'audio']);
    expect(container.querySelector('img')).toHaveAttribute('src', PNG);
    expect(screen.getByText('Image sent to the model as 640×480')).toBeInTheDocument();
    expect(screen.getByText('Audio sent to the model')).toBeInTheDocument();
  });

  test('the files are a block above the bubble, not inside it', () => {
    const message = sentMessage('Question about the contract', { fileData: doc });
    renderMessages([message]);
    const block = screen.getByTestId('message-attachments');
    const text = screen.getByText('Question about the contract');
    expect(block.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text.closest('.chat-widget-message-content')).not.toContainElement(block);
  });

  test('a turn that is only files has no bubble to show, but keeps its files', () => {
    const message = sentMessage('', { fileData: doc });
    const { container } = renderMessages([message]);
    expect(screen.getByText('Contract.pdf')).toBeInTheDocument();
    const bubble = container.querySelector('.chat-widget-message-content');
    expect(bubble).toHaveStyle({ display: 'none' });
  });

  test('typed text that looks like HTML is text: no element, no remote image', () => {
    const typed = 'look <img src="https://evil.example/pixel.png" onerror="alert(1)"> here';
    const message = sentMessage(typed, { fileData: doc });
    const { container } = renderMessages([message]);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(typed)).toBeInTheDocument();
  });

  test('a file name that looks like HTML is a name, not markup', () => {
    const message = sentMessage('hi', {
      fileData: { ...doc, fileName: '<img src=x onerror=alert(1)>.pdf' }
    });
    const { container } = renderMessages([message]);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>.pdf')).toBeInTheDocument();
  });

  test('the typed text keeps its line breaks and its first line its indentation', () => {
    const message = sentMessage('  first\nsecond\n', {});
    const { container } = renderMessages([message]);
    const textNode = container.querySelector('.chat-widget-message-content div');
    expect(textNode.textContent).toBe('  first\nsecond');
    expect(textNode).toHaveClass('whitespace-pre-wrap');
  });
});

describe('the same turn after a reload', () => {
  const stored = {
    id: 'msg-1',
    role: 'user',
    content: 'Please check these',
    attachments: [
      {
        id: 'file_abc',
        type: 'application/pdf',
        name: 'Contract.pdf',
        bytes: 2400000,
        hasOriginal: true
      },
      { type: 'image/png', name: 'whiteboard.png', bytes: 4200 },
      { type: 'audio/mpeg', name: 'memo.mp3', bytes: 90000 }
    ]
  };

  test('shows the same cards in the same order as the live turn', () => {
    const live = sentMessage('Please check these', {
      imageData: image,
      audioData: audio,
      fileData: { ...doc, serverStored: true, fileId: 'file_abc', hasOriginal: true }
    });
    const reopened = transformStoredMessage(stored);
    const liveOrder = live.attachments.map(view => [view.kind, view.name, view.id]);
    const storedOrder = reopened.attachments.map(view => [view.kind, view.name, view.id]);
    expect(storedOrder).toEqual(liveOrder);
  });

  test('a stored file opens in the Files drawer; an image or audio file has nothing to open', () => {
    const reopened = transformStoredMessage(stored);
    renderMessages([reopened]);
    const cards = screen.getAllByTestId('message-attachment');
    // Without a drawer (no ChatFilesContext) none of them is a button
    expect(cards).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Contract\.pdf/ })).not.toBeInTheDocument();
  });

  test('a reopened message whose text mentions an image tag shows it literally', () => {
    const reopened = transformStoredMessage({
      id: 'msg-2',
      role: 'user',
      content: '<img src="https://evil.example/pixel.png"> hello'
    });
    const { container } = renderMessages([reopened]);
    expect(container.querySelector('img')).toBeNull();
    expect(
      screen.getByText('<img src="https://evil.example/pixel.png"> hello')
    ).toBeInTheDocument();
  });
});
