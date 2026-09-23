/**
 * AzureSpeechRecognition.initRecognizer — auth modes.
 *
 * An on-prem Azure Speech container (air-gapped) needs no key: without a
 * server-side key the recognizer must connect straight to the host and never
 * request a token. With a key it fetches the short-lived token from iHub.
 */
jest.mock('microsoft-cognitiveservices-speech-sdk', () => {
  const fromHost = jest.fn(url => ({ kind: 'host', url }));
  const fromAuthorizationToken = jest.fn((token, region) => ({ kind: 'token', token, region }));
  return {
    SpeechConfig: { fromHost, fromAuthorizationToken },
    AudioConfig: { fromDefaultMicrophoneInput: jest.fn(() => ({})) },
    SpeechRecognizer: jest.fn(function (config) {
      this.config = config;
    })
  };
});

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`
}));

import * as speechSdk from 'microsoft-cognitiveservices-speech-sdk';
import AzureSpeechRecognition from '../../../client/src/utils/azureRecognitionService';

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ token: 'the-token', region: 'westeurope' })
  }));
});

test('keyless with a host: connects to the host and requests no token', async () => {
  const r = new AzureSpeechRecognition();
  r.host = 'ws://speech.internal:5000';
  r.useServerToken = false;
  await r.initRecognizer();

  expect(global.fetch).not.toHaveBeenCalled();
  expect(speechSdk.SpeechConfig.fromHost).toHaveBeenCalledTimes(1);
  expect(speechSdk.SpeechConfig.fromHost.mock.calls[0][0].host).toBe('speech.internal:5000');
  expect(r.recognition.config.authorizationToken).toBeUndefined();
});

test('keyless without a host: throws instead of building a recognizer', async () => {
  const r = new AzureSpeechRecognition();
  r.useServerToken = false;
  await expect(r.initRecognizer()).rejects.toThrow(/subscription key/i);
  expect(r.recognition).toBeUndefined();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('with a server key: fetches the token and uses the region', async () => {
  const r = new AzureSpeechRecognition();
  await r.initRecognizer();

  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(speechSdk.SpeechConfig.fromAuthorizationToken).toHaveBeenCalledWith(
    'the-token',
    'westeurope'
  );
});
