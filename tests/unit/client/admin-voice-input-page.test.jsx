/**
 * Admin → Voice Input (issue #2622): what apps use for voice input and read
 * aloud, and the test panel.
 *
 * - Voice input is the browser, Azure Speech or an enabled streaming
 *   transcription model (dictation needs a live model). It is saved into
 *   platform.speech and pushed to the client-wide platform config. Model endpoints live on the
 *   models, so the page has no endpoint fields of its own.
 * - Azure keeps its connection settings and a server-side "Test connection".
 * - The live dictation test and the record → transcribe test run the same
 *   recognizer / transcription path as a chat, against the SAVED config.
 *
 * - Voice mode (preview, issue #2868) is a section of the same page: the
 *   platform switch and parameters are saved into platform.speech.voiceMode,
 *   next to everything else in `speech`. "Try it" runs a session with the
 *   unsaved form, and is disabled while the `voiceMode` feature flag is off.
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
const mockPlatformConfig = { current: {} };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({
    platformConfig: mockPlatformConfig.current,
    refreshConfig: mockRefreshConfig
  })
}));

// "Try it" owns the microphone and the audio; here it only shows what it was given.
jest.mock(
  '../../../client/src/features/voice/components/VoiceModeTryButton',
  () => ({
    __esModule: true,
    default: ({ speech }) => (
      <button type="button" data-testid="voice-mode-try" data-speech={JSON.stringify(speech)}>
        Try it (real)
      </button>
    )
  }),
  { virtual: true }
);

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

// The transcription-model recognizer: interim text on start, the final on stop.
const mockRecognizers = [];
jest.mock('../../../client/src/utils/modelRecognitionService', () => ({
  __esModule: true,
  default: class FakeModelRecognition {
    usesTextEventShape = true;
    constructor(modelId) {
      this.modelId = modelId;
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
  defaultService: 'model',
  dictation: { modelId: 'voxtral' },
  realtime: { maxConnections: 10 },
  azure: { enabled: false, host: '', region: 'westeurope', subscriptionKey: '***REDACTED***' }
};

// GET /api/admin/models: every model, whatever the admin's own model
// permissions. Only enabled transcription models are offered; voice input
// only the streaming ones.
const MODELS = [
  {
    id: 'voxtral',
    name: { en: 'Voxtral' },
    modelType: 'transcription',
    provider: 'vllm-realtime',
    enabled: true
  },
  {
    id: 'gemini-transcribe',
    name: { en: 'Gemini Transcribe' },
    modelType: 'transcription',
    provider: 'google-transcribe'
  },
  {
    id: 'old-whisper',
    name: { en: 'Old Whisper' },
    modelType: 'transcription',
    provider: 'vllm-realtime',
    enabled: false
  },
  { id: 'gpt', name: { en: 'GPT' }, modelType: 'chat', enabled: true },
  { id: 'untyped-chat', name: { en: 'Untyped' }, enabled: true },
  { id: 'voxtral-tts', name: { en: 'Voxtral TTS' }, modelType: 'tts', enabled: true },
  { id: 'old-tts', name: { en: 'Old TTS' }, modelType: 'tts', enabled: false }
];

let platformOnDisk;

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatformConfig.current = {};
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

const voiceInput = () => screen.getByLabelText('Speech recognition');
const optionValues = select => [...select.querySelectorAll('option')].map(o => o.value);

async function renderPage() {
  render(<AdminVoiceInputPage />);
  await screen.findByLabelText('Speech recognition');
  // The admin model list has loaded once its models are offered.
  await screen.findAllByRole('option', { name: 'Gemini Transcribe' });
}

describe('voice input', () => {
  test('shows the saved choices and saves changed ones into platform.speech', async () => {
    await renderPage();
    await waitFor(() => expect(voiceInput()).toHaveValue('model:voxtral'));

    fireEvent.change(voiceInput(), { target: { value: 'browser' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    await screen.findByText('Voice input settings saved.');
    expect(platformOnDisk.speech.defaultService).toBe('browser');
    // The last model picked stays, so switching back is one click.
    expect(platformOnDisk.speech.dictation).toEqual({ modelId: 'voxtral' });
    expect(platformOnDisk.speech).not.toHaveProperty('transcription');
    // Unrelated platform settings and the connection limits round-trip untouched.
    expect(platformOnDisk.defaultLanguage).toBe('en');
    expect(platformOnDisk.speech.realtime).toEqual({ maxConnections: 10 });
    // Chats and the app editor see the new defaults without a reload.
    expect(mockRefreshConfig).toHaveBeenCalled();
  });

  test('voice input can be any enabled streaming transcription model', async () => {
    platformOnDisk.speech.defaultService = 'browser';
    await renderPage();
    expect(optionValues(voiceInput())).toEqual(['browser', 'azure', 'model:voxtral']);

    fireEvent.change(voiceInput(), { target: { value: 'model:voxtral' } });
    expect(screen.getByText(/The microphone streams through the iHub server/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    await screen.findByText('Voice input settings saved.');
    expect(platformOnDisk.speech.defaultService).toBe('model');
    expect(platformOnDisk.speech.dictation).toEqual({ modelId: 'voxtral' });
  });

  test('flags a batch model saved as the voice input model', async () => {
    platformOnDisk.speech.dictation.modelId = 'gemini-transcribe';
    await renderPage();
    expect(voiceInput()).toHaveValue('model:gemini-transcribe');
    expect(await screen.findByText(/or does not stream\./)).toBeInTheDocument();
  });

  test('has no endpoint fields: those live on the models', async () => {
    await renderPage();
    expect(screen.queryByLabelText('Realtime WebSocket URL')).not.toBeInTheDocument();
    expect(screen.queryByText('vLLM Realtime (server-proxied)')).not.toBeInTheDocument();
  });

  test('has no default transcription model: audio goes to the model picked in the chat', async () => {
    await renderPage();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/models', { method: 'GET' });
  });

  test('warns when Azure is picked but not enabled', async () => {
    await renderPage();
    fireEvent.change(voiceInput(), { target: { value: 'azure' } });
    expect(
      screen.getByText(/Azure Speech is not enabled below\. Until it is, apps that follow/)
    ).toBeInTheDocument();
  });

  test('flags a voice input model that is no longer available', async () => {
    platformOnDisk.speech.dictation.modelId = 'old-whisper';
    await renderPage();
    expect(voiceInput()).toHaveValue('model:old-whisper');
    expect(
      await screen.findByText(
        /does not stream\. Until a streaming model is chosen, apps that follow/
      )
    ).toBeInTheDocument();
  });
});

const voiceModeSection = () => within(screen.getByTestId('voice-mode-section'));
const saveForm = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  await screen.findByText('Voice input settings saved.');
};
const FLAG_ON = { featuresMap: { voiceMode: true } };

describe('voice mode', () => {
  test('shows the section with the defaults when nothing is saved', async () => {
    await renderPage();
    const section = voiceModeSection();

    expect(section.getByRole('heading', { name: /^Voice mode/ })).toBeInTheDocument();
    expect(section.getByLabelText('Enable voice mode')).not.toBeChecked();
    expect(
      section.getByLabelText('Turn voice mode on for apps that do not decide themselves')
    ).not.toBeChecked();
    expect(section.getByLabelText('Listening style')).toHaveValue('hands-free');
    expect(section.getByLabelText('Reasoning effort')).toHaveValue('low');
    expect(section.getByLabelText('End of turn after silence (ms)')).toHaveValue(800);
    expect(section.getByLabelText('Longest session (minutes)')).toHaveValue(30);
    expect(section.getByLabelText('Let users interrupt the answer by speaking')).toBeChecked();
    expect(section.getByLabelText('Instruction (English)')).toHaveValue('');
    expect(section.getByLabelText('Instruction (Deutsch)')).toHaveValue('');
    // The built-in text is the hint under each field.
    expect(section.getByTestId('voice-mode-builtin-en')).toHaveTextContent(
      /The user is talking to you by voice and hears your answer read aloud/
    );
    expect(section.getByTestId('voice-mode-builtin-de')).toHaveTextContent(
      /Der Nutzer spricht per Sprache mit dir/
    );
  });

  test('shows the saved settings', async () => {
    platformOnDisk.speech.voiceMode = {
      enabled: true,
      appDefault: true,
      ttsModelId: 'voxtral-tts',
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      endOfTurnSilenceMs: 1200,
      thinkingLevel: 'high',
      maxSessionMinutes: 45,
      systemPrompt: { en: 'Be brief.' }
    };
    await renderPage();
    const section = voiceModeSection();

    expect(section.getByLabelText('Enable voice mode')).toBeChecked();
    expect(
      section.getByLabelText('Turn voice mode on for apps that do not decide themselves')
    ).toBeChecked();
    await waitFor(() =>
      expect(section.getByLabelText('Text-to-speech model')).toHaveValue('voxtral-tts')
    );
    expect(section.getByLabelText('Listening style')).toHaveValue('push-to-talk');
    expect(section.getByLabelText('Let users interrupt the answer by speaking')).not.toBeChecked();
    expect(section.getByLabelText('End of turn after silence (ms)')).toHaveValue(1200);
    expect(section.getByLabelText('Reasoning effort')).toHaveValue('high');
    expect(section.getByLabelText('Longest session (minutes)')).toHaveValue(45);
    expect(section.getByLabelText('Instruction (English)')).toHaveValue('Be brief.');
  });

  test('saves the platform switch and the parameters into platform.speech.voiceMode', async () => {
    platformOnDisk.speech.tts = {
      enabled: true,
      defaultModelId: 'voxtral-tts',
      maxCharacters: 5000
    };
    await renderPage();
    const section = voiceModeSection();

    fireEvent.click(section.getByLabelText('Enable voice mode'));
    fireEvent.click(
      section.getByLabelText('Turn voice mode on for apps that do not decide themselves')
    );
    fireEvent.change(section.getByLabelText('Text-to-speech model'), {
      target: { value: 'voxtral-tts' }
    });
    fireEvent.change(section.getByLabelText('Listening style'), {
      target: { value: 'push-to-talk' }
    });
    fireEvent.click(section.getByLabelText('Let users interrupt the answer by speaking'));
    fireEvent.change(section.getByLabelText('End of turn after silence (ms)'), {
      target: { value: '1200' }
    });
    fireEvent.change(section.getByLabelText('Reasoning effort'), { target: { value: 'medium' } });
    fireEvent.change(section.getByLabelText('Longest session (minutes)'), {
      target: { value: '45' }
    });
    fireEvent.change(section.getByLabelText('Instruction (Deutsch)'), {
      target: { value: 'Antworte kurz.' }
    });
    await saveForm();

    expect(platformOnDisk.speech.voiceMode).toEqual({
      enabled: true,
      appDefault: true,
      ttsModelId: 'voxtral-tts',
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      endOfTurnSilenceMs: 1200,
      thinkingLevel: 'medium',
      maxSessionMinutes: 45,
      systemPrompt: { de: 'Antworte kurz.' }
    });
    // Everything else in `speech` and in the platform config is untouched.
    expect(platformOnDisk.speech.defaultService).toBe('model');
    expect(platformOnDisk.speech.realtime).toEqual({ maxConnections: 10 });
    expect(platformOnDisk.speech.tts).toEqual({
      enabled: true,
      defaultModelId: 'voxtral-tts',
      maxCharacters: 5000
    });
    expect(platformOnDisk.defaultLanguage).toBe('en');
    expect(mockRefreshConfig).toHaveBeenCalled();
  });

  test('saving an untouched form writes the defaults and keeps keys it does not know', async () => {
    platformOnDisk.speech.voiceMode = {
      enabled: true,
      futureSetting: 'keep me',
      systemPrompt: { fr: 'Réponds brièvement.' }
    };
    await renderPage();
    await saveForm();

    expect(platformOnDisk.speech.voiceMode).toEqual({
      enabled: true,
      appDefault: false,
      ttsModelId: '',
      listeningStyle: 'hands-free',
      bargeIn: true,
      endOfTurnSilenceMs: 800,
      thinkingLevel: 'low',
      maxSessionMinutes: 30,
      futureSetting: 'keep me',
      // Languages without a field here are not lost.
      systemPrompt: { fr: 'Réponds brièvement.' }
    });
  });

  test('keeps the numbers inside their range when saving', async () => {
    await renderPage();
    const section = voiceModeSection();

    fireEvent.change(section.getByLabelText('End of turn after silence (ms)'), {
      target: { value: '50' }
    });
    fireEvent.change(section.getByLabelText('Longest session (minutes)'), {
      target: { value: '' }
    });
    await saveForm();

    expect(platformOnDisk.speech.voiceMode.endOfTurnSilenceMs).toBe(300);
    expect(platformOnDisk.speech.voiceMode.maxSessionMinutes).toBe(30);

    fireEvent.change(section.getByLabelText('End of turn after silence (ms)'), {
      target: { value: '99999' }
    });
    fireEvent.change(section.getByLabelText('Longest session (minutes)'), {
      target: { value: '1000' }
    });
    await saveForm();

    expect(platformOnDisk.speech.voiceMode.endOfTurnSilenceMs).toBe(3000);
    expect(platformOnDisk.speech.voiceMode.maxSessionMinutes).toBe(240);
  });

  test('an out-of-range number is corrected when the field is left', async () => {
    await renderPage();
    const silence = voiceModeSection().getByLabelText('End of turn after silence (ms)');

    fireEvent.change(silence, { target: { value: '99999' } });
    expect(silence).toHaveValue(99999);
    fireEvent.blur(silence);
    expect(silence).toHaveValue(3000);
  });

  test('the system prompt override resets to the built-in text and is saved without blanks', async () => {
    platformOnDisk.speech.voiceMode = { systemPrompt: { en: 'Be brief.', de: 'Kurz.' } };
    await renderPage();
    const section = voiceModeSection();
    const resetButtons = section.getAllByRole('button', { name: 'Reset to built-in' });

    // English first, German second.
    fireEvent.click(resetButtons[0]);
    expect(section.getByLabelText('Instruction (English)')).toHaveValue('');
    expect(resetButtons[0]).toBeDisabled();
    expect(resetButtons[1]).toBeEnabled();
    fireEvent.change(section.getByLabelText('Instruction (Deutsch)'), { target: { value: '   ' } });
    await saveForm();

    expect(platformOnDisk.speech.voiceMode.systemPrompt).toEqual({});
  });

  test('offers the text-to-speech models and names the default one', async () => {
    platformOnDisk.speech.tts = { enabled: true, defaultModelId: 'voxtral-tts' };
    await renderPage();
    const picker = voiceModeSection().getByLabelText('Text-to-speech model');

    await waitFor(() => expect(optionValues(picker)).toEqual(['', 'voxtral-tts', 'old-tts']));
    expect(
      within(picker).getByRole('option', { name: 'Default text-to-speech model (Voxtral TTS)' })
    ).toHaveValue('');
    expect(within(picker).getByRole('option', { name: 'Old TTS (disabled)' })).toBeInTheDocument();
  });

  test('warns when there is no text-to-speech model at all, or the chosen one is disabled', async () => {
    await renderPage();
    const section = voiceModeSection();
    expect(
      section.getByText(/No text-to-speech model is set here or under "Read aloud"/)
    ).toBeInTheDocument();

    fireEvent.change(section.getByLabelText('Text-to-speech model'), {
      target: { value: 'old-tts' }
    });
    expect(
      section.getByText(/This model is disabled, so voice mode is not offered/)
    ).toBeInTheDocument();
  });

  test('points out that voice mode needs read aloud switched on', async () => {
    platformOnDisk.speech.tts = { enabled: false, defaultModelId: 'voxtral-tts' };
    await renderPage();
    const section = voiceModeSection();
    expect(section.getByText(/Read aloud is switched off above/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show a read-aloud button on chat messages'));
    expect(section.queryByText(/Read aloud is switched off above/)).not.toBeInTheDocument();
  });

  describe('feature flag', () => {
    test('off: keeps the section, explains the flag and disables "Try it"', async () => {
      await renderPage();
      const section = voiceModeSection();

      expect(section.getByTestId('voice-mode-flag-note')).toHaveTextContent(
        /Enable the "Voice Mode" preview feature under Admin → Features/
      );
      expect(section.getByRole('button', { name: 'Try it' })).toBeDisabled();
      expect(screen.queryByTestId('voice-mode-try')).not.toBeInTheDocument();
      // The settings can still be prepared and saved.
      fireEvent.click(section.getByLabelText('Enable voice mode'));
      await saveForm();
      expect(platformOnDisk.speech.voiceMode.enabled).toBe(true);
    });

    test('on: no note, and "Try it" gets the unsaved form', async () => {
      mockPlatformConfig.current = FLAG_ON;
      await renderPage();
      const section = voiceModeSection();

      expect(section.queryByTestId('voice-mode-flag-note')).not.toBeInTheDocument();
      expect(section.queryByRole('button', { name: 'Try it' })).not.toBeInTheDocument();

      fireEvent.change(section.getByLabelText('Longest session (minutes)'), {
        target: { value: '12' }
      });
      fireEvent.change(voiceInput(), { target: { value: 'browser' } });
      const tried = JSON.parse(section.getByTestId('voice-mode-try').dataset.speech);

      // Unsaved voice mode settings and unsaved speech service, in the shape a chat reads.
      expect(tried.voiceMode.maxSessionMinutes).toBe(12);
      expect(tried.defaultService).toBe('browser');
      expect(tried.tts).toEqual({ enabled: false, defaultModelId: '' });
      expect(platformOnDisk.speech.voiceMode).toBeUndefined();
    });

    test('a flag that is off for another reason than the default also shows the note', async () => {
      mockPlatformConfig.current = { featuresMap: { voiceMode: false } };
      await renderPage();
      expect(voiceModeSection().getByTestId('voice-mode-flag-note')).toBeInTheDocument();
    });
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
    fireEvent.change(voiceInput(), { target: { value: 'browser' } });
    expect(screen.getByText(/You have unsaved changes/)).toBeInTheDocument();
  });

  test('live dictation: preselects the platform default and shows the transcript', async () => {
    await renderPage();
    const service = screen.getByLabelText('Service');
    await waitFor(() => expect(service).toHaveValue('model:voxtral'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start dictation test' }));
    });
    expect(await screen.findByText('Listening: speak now.')).toBeInTheDocument();
    expect(screen.getByTestId('dictation-transcript')).toHaveTextContent('hello wor');
    expect(mockRecognizers).toHaveLength(1);
    expect(mockRecognizers[0].modelId).toBe('voxtral');
    expect(mockRecognizers[0].continuous).toBe(true);
    expect(mockRecognizers[0].lang).toBe('en-US');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });
    expect(screen.getByTestId('dictation-transcript')).toHaveTextContent(/^hello world$/);
    expect(screen.getByText('Dictation works.')).toBeInTheDocument();
  });

  test('recording: records, transcribes with the first model and reports timings', async () => {
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

    expect(
      await screen.findByText('Transcription failed: Transcription model "voxtral" is disabled')
    ).toBeInTheDocument();
    expect(
      screen.getByText('model-disabled: Transcription model "voxtral" is disabled')
    ).toBeInTheDocument();
  });
});
