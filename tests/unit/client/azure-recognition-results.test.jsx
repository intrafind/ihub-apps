/**
 * AzureSpeechRecognition result shape.
 *
 * useVoiceRecognition parses results by `usesTextEventShape`. Azure emitted
 * `{ text, isFinal }` without setting it, so its results were read as browser
 * SpeechRecognition events (`event.results.length` on undefined) and lost.
 * Single-shot mode also emitted the raw SDK result object.
 */
const mockRecognizeOnce = { result: null };

jest.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  ResultReason: { RecognizedSpeech: 'recognized', NoMatch: 'nomatch', Canceled: 'canceled' },
  CancellationReason: { Error: 'error' },
  CancellationDetails: { fromResult: () => ({ reason: 'error' }) },
  CancellationErrorCode: {},
  SpeechConfig: { fromHost: jest.fn(() => ({})), fromAuthorizationToken: jest.fn(() => ({})) },
  AudioConfig: { fromDefaultMicrophoneInput: jest.fn(() => ({})) },
  SpeechRecognizer: jest.fn(function () {
    this.recognizeOnceAsync = callback => callback(mockRecognizeOnce.result);
    this.close = jest.fn();
  })
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`
}));

import AzureSpeechRecognition from '../../../client/src/utils/azureRecognitionService';

async function singleShot(result) {
  mockRecognizeOnce.result = result;
  const recognition = new AzureSpeechRecognition();
  recognition.host = 'ws://speech.internal:5000';
  recognition.useServerToken = false;
  const events = [];
  recognition.onstart = () => events.push(['start']);
  recognition.onresult = e => events.push(['result', e]);
  recognition.onerror = e => events.push(['error', e.error]);
  recognition.onend = () => events.push(['end']);
  await recognition.initRecognizer();
  recognition.start();
  return { recognition, events };
}

test('marks itself as emitting { text, isFinal } results', () => {
  expect(new AzureSpeechRecognition().usesTextEventShape).toBe(true);
});

test('single-shot: a recognized phrase is one final { text, isFinal } result, then end', async () => {
  const { events } = await singleShot({ reason: 'recognized', text: 'Hallo Welt' });
  expect(events).toEqual([['start'], ['result', { text: 'Hallo Welt', isFinal: true }], ['end']]);
});

test('single-shot: no speech ends the session after the error', async () => {
  const { events } = await singleShot({ reason: 'nomatch' });
  expect(events).toEqual([['start'], ['error', 'no-speech'], ['end']]);
});
