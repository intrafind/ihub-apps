/**
 * A turn spoken in voice mode stays marked as spoken when the chat is reopened
 * (issue #2868): the server stores `metadata.inputMode: 'voice'` with the user
 * message, and the client puts it back so the bubble shows the waveform icon.
 */
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';

// `debugLog` reads `import.meta`, which this jest setup cannot load.
jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));

describe('transformStoredMessage and the voice marker', () => {
  test('restores the marker of a spoken user message', () => {
    const message = transformStoredMessage({
      id: 'u1',
      role: 'user',
      content: 'What is the capital of France',
      metadata: { inputMode: 'voice' }
    });
    expect(message.metadata).toEqual({ inputMode: 'voice' });
  });

  test('a typed message has no marker', () => {
    expect(transformStoredMessage({ id: 'u2', role: 'user', content: 'hi' }).metadata).toBe(
      undefined
    );
  });

  test('keeps only the marker, and only on user messages', () => {
    expect(
      transformStoredMessage({
        id: 'u3',
        role: 'user',
        content: 'hi',
        metadata: { inputMode: 'voice', secret: 'x' }
      }).metadata
    ).toEqual({ inputMode: 'voice' });
    expect(
      transformStoredMessage({
        id: 'a1',
        role: 'assistant',
        content: 'hello',
        metadata: { inputMode: 'voice' }
      }).metadata
    ).toBe(undefined);
  });
});
