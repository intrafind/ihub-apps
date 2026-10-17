/**
 * What the voice mode overlay says when the session fails (issue #2868): every
 * code gets text in the user's language, and the message the session carries
 * (English, from the browser, an adapter or the server) is never shown.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import VoiceModeOverlay from '../../../client/src/features/voice/components/VoiceModeOverlay';
import {
  VOICE_STATUS,
  initialVoiceModeState
} from '../../../client/src/features/voice/utils/voiceModeReducer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions) => (typeof defaultOrOptions === 'string' ? defaultOrOptions : key)
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const RAW = 'raw english detail from the adapter';

function renderError(code) {
  const state = {
    ...initialVoiceModeState({ listeningStyle: 'hands-free', bargeIn: true }),
    status: VOICE_STATUS.ERROR,
    error: { code, message: RAW }
  };
  const noop = () => {};
  render(
    <VoiceModeOverlay
      appName="Chat"
      voiceMode={{
        state,
        prefs: { listeningStyle: 'hands-free', bargeIn: true, captions: true },
        levelRef: { current: 0 },
        end: noop,
        retry: noop,
        interrupt: noop,
        setMuted: noop,
        pushToTalkStart: noop,
        pushToTalkEnd: noop,
        setListeningStyle: noop,
        setBargeIn: noop,
        setCaptions: noop
      }}
    />
  );
  // The error text is the alert's; the status line stays a quiet live region.
  return screen.getByRole('alert').textContent;
}

describe('VoiceModeOverlay error text', () => {
  test.each([
    ['mic-denied', /Microphone access was blocked/],
    ['mic-missing', /No microphone was found/],
    ['mic-busy', /may be in use by another application/],
    ['mic-lost', /microphone stopped working/],
    ['unsupported', /not supported in this browser/],
    ['audio-unsupported', /not supported in this browser/],
    ['vad-unavailable', /Voice detection could not be loaded/],
    ['feature-disabled', /Voice mode is switched off/],
    ['voice-mode-disabled', /Voice mode is switched off/],
    ['no-speech', /nothing was said for a while/],
    ['closed', /connection to speech recognition was lost/],
    ['connection', /connection to speech recognition was lost/],
    ['not-permitted', /not permitted to use this transcription model/],
    ['server-busy', /busy right now/],
    ['session-limit', /maximum duration/],
    ['service', /speech service is not available/],
    ['no-model', /speech service is not available/],
    ['unknown-model', /speech service is not available/],
    ['model-disabled', /speech service is not available/],
    ['no-endpoint', /speech service is not available/],
    ['start-failed', /Voice mode stopped because of an error/],
    ['something-new', /Voice mode stopped because of an error/]
  ])('%s is shown as translated text, not the raw message', (code, expected) => {
    const text = renderError(code);
    expect(text).toMatch(expected);
    expect(text).not.toContain(RAW);
  });
});
