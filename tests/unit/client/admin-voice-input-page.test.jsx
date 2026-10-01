/**
 * Admin → Voice Input (issue #2622): platform-wide defaults and the test panel.
 *
 * - The defaults (dictation service, transcription model) are saved into
 *   platform.speech and pushed to the client-wide platform config.
 * - Azure gets a server-side "Test connection" like vLLM Realtime.
 * - The live dictation test and the record → transcribe test run the same
 *   recognizer / transcription path as a chat, against the SAVED config.
 *
 * The admin API, the microphone recorder, the transcription socket and the
 * recognizers are stubbed; everything else is the real page.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));

// The read-aloud test player builds its URL here (import.meta, not CJS-safe).
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`,
  buildPath: path => `/${path}`,
  buildAssetUrl: path => path
}));

const mockRefreshConfig = jest.fn();
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: {}, refreshConfig: mockRefreshConfig })
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));

// The vLLM realtime recognizer: interim text on start, the final on stop.
const mockRecognizers = [];
jest.mock('../../../client/src/utils/vllmRealtimeRecognitionService', () => ({
  __esModule: true,
  default: class FakeVllmRecognition {
    usesTextEventShape = true;
    constructor() {
      mockRecognizers.push(this);
    }
    async start() {
      this.onstart();
      this.onresult({ text: 'hello wor', isFinal: false });
    }
    stop() {
      this.onresult({ text: 'hello world', isFinal: true });
      this.onend();
    }
  }
}));
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class FakeAzureRecognition {}
}));

const mockRecorder = { stopResult: null };
jest.mock('../../../client/src/utils/audioRecorder', () => ({
  __esModule: true,
  AudioBufferRecorder: class FakeRecorder {
    async start() {}
    async stop() {
      return mockRecorder.stopResult;
    }
    cancel() {}
  }
}));

const mockTranscribe = jest.fn();
jest.mock('../../../client/src/utils/transcribeAudioBuffer', () => ({
  __esModule: true,
  transcribeAudioBuffer: (...args) => mockTranscribe(...args)
}));

import AdminVoiceInputPage from '../../../client/src/features/admin/pages/AdminVoiceInputPage';

const SAVED_SPEECH = {
  defaultService: 'vllm-realtime',
  transcription: { defaultModelId: 'voxtral' },
  realtime: { enabled: true, url: 'ws://vllm:8080/v1/realtime', model: 'm', apiKey: '' },
  azure: { enabled: false, host: '', region: 'westeurope', subscriptionKey: '***REDACTED***' }
};

// GET /api/admin/models: every model, whatever the admin's own model
// permissions. Only enabled transcription models are offered.
const MODELS = [
  { id: 'gemini-transcribe', name: { en: 'Gemini Transcribe' }, modelType: 'transcription' },
  { id: 'voxtral', name: { en: 'Voxtral' }, modelType: 'transcription', enabled: true },
  { id: 'old-whisper', name: { en: 'Old Whisper' }, modelType: 'transcription', enabled: false },
  { id: 'gpt', name: { en: 'GPT' }, modelType: 'chat', enabled: true },
  { id: 'untyped-chat', name: { en: 'Untyped' }, enabled: true }
];

let platformOnDisk;

beforeEach(() => {
  jest.clearAllMocks();
  mockRecognizers.length = 0;
  platformOnDisk = { defaultLanguage: 'en', speech: structuredClone(SAVED_SPEECH) };
  mockRecorder.stopResult = { audioBuffer: { length: 24000 }, durationSeconds: 1.5 };
  mockMakeAdminApiCall.mockImplementation(async (url, { method, body } = {}) => {
    if (url === '/admin/configs/platform' && method === 'GET') {
      return { data: structuredClone(platformOnDisk) };
    }
    if (url === '/admin/configs/platform' && method === 'POST') {
      platformOnDisk = structuredClone(body);
      return { data: {} };
    }
    if (url === '/admin/models' && method === 'GET') {
      return { data: MODELS };
    }
    if (url === '/admin/voice/azure/test') {
      return {
        data: { ok: true, code: 'token-issued', region: 'northeurope', message: 'server text' }
      };
    }
    throw new Error(`unexpected call ${method} ${url}`);
  });
});

async function renderPage() {
  render(<AdminVoiceInputPage />);
  await screen.findByLabelText('Dictation service (microphone button)');
  // The admin model list has loaded once its models are offered.
  await screen.findAllByRole('option', { name: 'Gemini Transcribe' });
}

describe('defaults', () => {
  test('shows the saved defaults and saves changed ones into platform.speech', async () => {
    await renderPage();
    const service = screen.getByLabelText('Dictation service (microphone button)');
    const model = screen.getByLabelText('Transcription model (recording)');
    expect(service).toHaveValue('vllm-realtime');
    await waitFor(() => expect(model).toHaveValue('voxtral'));

    fireEvent.change(service, { target: { value: 'browser' } });
    fireEvent.change(model, { target: { value: 'gemini-transcribe' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    await screen.findByText('Voice input settings saved.');
    expect(platformOnDisk.speech.defaultService).toBe('browser');
    expect(platformOnDisk.speech.transcription).toEqual({ defaultModelId: 'gemini-transcribe' });
    // Unrelated platform settings and the backends round-trip untouched.
    expect(platformOnDisk.defaultLanguage).toBe('en');
    expect(platformOnDisk.speech.realtime.url).toBe('ws://vllm:8080/v1/realtime');
    // Chats and the app editor see the new defaults without a reload.
    expect(mockRefreshConfig).toHaveBeenCalled();
  });

  test('offers every enabled transcription model, from the admin model list', async () => {
    await renderPage();
    const options = [
      ...screen.getByLabelText('Transcription model (recording)').querySelectorAll('option')
    ].map(o => o.value);
    expect(options).toEqual(['', 'gemini-transcribe', 'voxtral']);
    expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/models', { method: 'GET' });
  });

  test('warns when the default backend is not enabled', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Dictation service (microphone button)'), {
      target: { value: 'azure' }
    });
    expect(
      screen.getByText(/Azure Speech is not enabled below\. Until it is, apps that follow/)
    ).toBeInTheDocument();
  });

  test('flags a default transcription model that is no longer available', async () => {
    platformOnDisk.speech.transcription.defaultModelId = 'deleted-model';
    await renderPage();
    expect(await screen.findByText(/disabled or no longer exists/)).toBeInTheDocument();
  });
});

test('Azure: tests the unsaved form values on the server', async () => {
  await renderPage();
  fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'northeurope' } });
  const azureCard = screen
    .getByText('Azure Speech', { selector: 'h2' })
    .closest('div').parentElement;
  await act(async () => {
    fireEvent.click(within(azureCard).getByRole('button', { name: 'Test connection' }));
  });

  // Translated from the result code, not the server's English text.
  expect(
    await screen.findByText('Key accepted: Azure issued a token for region "northeurope".')
  ).toBeInTheDocument();
  expect(screen.queryByText('server text')).not.toBeInTheDocument();
  expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/voice/azure/test', {
    method: 'POST',
    body: { region: 'northeurope', host: '', subscriptionKey: '***REDACTED***' }
  });
});

describe('test panel', () => {
  test('points out that the tests run against the saved configuration', async () => {
    await renderPage();
    expect(screen.queryByText(/You have unsaved changes/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'other' } });
    expect(screen.getByText(/You have unsaved changes/)).toBeInTheDocument();
  });

  test('live dictation: preselects the platform default and shows the transcript', async () => {
    await renderPage();
    const service = screen.getByLabelText('Service');
    expect(service).toHaveValue('vllm-realtime');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start dictation test' }));
    });
    expect(await screen.findByText('Listening: speak now.')).toBeInTheDocument();
    expect(screen.getByTestId('dictation-transcript')).toHaveTextContent('hello wor');
    expect(mockRecognizers).toHaveLength(1);
    expect(mockRecognizers[0].continuous).toBe(true);
    expect(mockRecognizers[0].lang).toBe('en-US');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });
    expect(screen.getByTestId('dictation-transcript')).toHaveTextContent(/^hello world$/);
    expect(screen.getByText('Dictation works.')).toBeInTheDocument();
  });

  test('recording: records, transcribes with the default model and reports timings', async () => {
    mockTranscribe.mockImplementation(async (_buffer, { onDelta }) => {
      onDelta('Guten');
      return 'Guten Tag';
    });
    await renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Transcription model')).toHaveValue('voxtral')
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
    });

    expect(await screen.findByTestId('recording-transcript')).toHaveTextContent('Guten Tag');
    expect(screen.getByText(/Transcribed 1\.5 s of audio in \d+ ms\./)).toBeInTheDocument();
    expect(mockTranscribe).toHaveBeenCalledWith(
      mockRecorder.stopResult.audioBuffer,
      expect.objectContaining({ modelId: 'voxtral' })
    );
  });

  test('recording: shows the readable error and the raw server code', async () => {
    mockTranscribe.mockRejectedValue(
      Object.assign(new Error('Transcription model "voxtral" is disabled'), {
        code: 'model-disabled'
      })
    );
    await renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Transcription model')).toHaveValue('voxtral')
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
    });

    expect(await screen.findByText('Transcription failed. Please try again.')).toBeInTheDocument();
    expect(
      screen.getByText('model-disabled: Transcription model "voxtral" is disabled')
    ).toBeInTheDocument();
  });
});
