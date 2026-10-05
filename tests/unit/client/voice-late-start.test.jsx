/**
 * The microphone must not switch on after the user already stopped or left.
 *
 * Starting voice input awaits a permission prompt (getUserMedia) or, for
 * Azure, a token fetch. Stopping or unmounting during that wait used to be
 * missed: the start continued afterwards and left a live microphone that
 * nothing could stop.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon() {
    return null;
  };
});
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildWsUrl: path => `ws://localhost${path}`,
  buildApiUrl: path => `/api${path}`
}));

const mockAzure = { instances: [] };
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class FakeAzureRecognition {
    usesTextEventShape = true;
    constructor() {
      this.init = null;
      this.close = jest.fn();
      this.start = jest.fn();
      this.stop = jest.fn();
      mockAzure.instances.push(this);
    }
    initRecognizer() {
      return new Promise(resolve => {
        this.init = resolve;
      });
    }
  }
}));

import ModelSpeechRecognition from '../../../client/src/utils/modelRecognitionService';
import MicrophoneCheck from '../../../client/src/features/admin/components/voice/MicrophoneCheck';
import DictationTest from '../../../client/src/features/admin/components/voice/DictationTest';

const t = (key, fallback) => fallback;

/** getUserMedia that stays pending until the test grants it. */
function pendingMicrophone() {
  const track = { stop: jest.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let grant;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn(() => new Promise(resolve => (grant = () => resolve(stream)))) }
  });
  return { track, grant: () => grant() };
}

beforeEach(() => {
  mockAzure.instances.length = 0;
  global.WebSocket = jest.fn();
  window.AudioContext = jest.fn();
});

afterEach(() => {
  delete navigator.mediaDevices;
});

test('transcription model: stop() during the permission prompt releases the microphone', async () => {
  const mic = pendingMicrophone();
  const recognition = new ModelSpeechRecognition('voxtral');
  recognition.onstart = jest.fn();

  const started = recognition.start();
  recognition.stop();
  mic.grant();
  await started;

  expect(mic.track.stop).toHaveBeenCalled();
  expect(global.WebSocket).not.toHaveBeenCalled();
  expect(recognition.onstart).not.toHaveBeenCalled();
});

test('microphone check: leaving during the permission prompt releases the microphone', async () => {
  const mic = pendingMicrophone();
  const { unmount } = render(<MicrophoneCheck t={t} />);

  fireEvent.click(screen.getByRole('button', { name: 'Check microphone' }));
  unmount();
  await act(async () => mic.grant());

  expect(mic.track.stop).toHaveBeenCalled();
  expect(window.AudioContext).not.toHaveBeenCalled();
});

test('dictation test: an Azure recognizer initialised after leaving is closed, not started', async () => {
  const speech = { defaultService: 'azure', azure: { enabled: true, keyConfigured: true } };
  const { unmount } = render(<DictationTest speech={speech} t={t} language="en" />);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start dictation test' }));
  });
  const [azure] = mockAzure.instances;
  expect(azure.init).toEqual(expect.any(Function));

  unmount();
  await act(async () => azure.init());

  expect(azure.close).toHaveBeenCalled();
  expect(azure.start).not.toHaveBeenCalled();
});

test('microphone check: a second click during the permission prompt starts nothing', async () => {
  const mic = pendingMicrophone();
  const { unmount } = render(<MicrophoneCheck t={t} />);
  const button = screen.getByRole('button', { name: 'Check microphone' });

  fireEvent.click(button);
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);

  unmount();
  await act(async () => mic.grant());
  expect(mic.track.stop).toHaveBeenCalled();
});
