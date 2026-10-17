import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * App editor → Input Mode & Microphone: an app's voice input can be the
 * platform default, the browser, Azure Speech or any enabled streaming
 * transcription model. A model choice is stored as `service: "model"` plus its `modelId`.
 *
 * Voice mode (issue #2868) sits under the microphone settings: a three-way
 * switch (platform default / on / off → `inputMode.voiceMode.enabled` absent /
 * true / false) and optional overrides. A setting that follows the platform is
 * never written, so an app keeps a clean config.
 */

// The recognizers speechService builds are not used here (import.meta, not CJS-safe).
jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class FakeAzureRecognition {}
}));
jest.mock('../../../client/src/utils/modelRecognitionService', () => ({
  __esModule: true,
  default: class FakeModelRecognition {}
}));

const mockPlatformConfig = { current: {} };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig.current })
}));

const InputModeSection =
  require('../../../client/src/features/admin/components/app-form/InputModeSection').default;

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) => options?.[name] ?? match);
};
const MODELS = [
  { id: 'voxtral', name: { en: 'Voxtral Mini' } },
  { id: 'gemini-live', name: { en: 'Gemini Transcribe Live' } }
];

function renderSection(speechRecognition) {
  const onChange = jest.fn();
  render(
    <InputModeSection
      app={{ id: 'chat', settings: { speechRecognition } }}
      onChange={onChange}
      t={t}
      transcriptionModels={MODELS}
      currentLanguage="en"
    />
  );
  return { onChange };
}

const serviceSelect = () =>
  screen
    .getAllByRole('combobox')
    .find(select => [...select.options].some(option => option.value === 'default'));

beforeEach(() => {
  mockPlatformConfig.current = {};
});

test('offers every transcription model next to the services', () => {
  renderSection({ service: 'default' });
  expect([...serviceSelect().options].map(o => o.value)).toEqual([
    'default',
    'browser',
    'azure',
    'model:voxtral',
    'model:gemini-live',
    'custom'
  ]);
});

test('picking a model stores the service and the model id', () => {
  const { onChange } = renderSection({ service: 'default' });
  fireEvent.change(serviceSelect(), { target: { value: 'model:gemini-live' } });
  expect(onChange.mock.calls[0][0].settings.speechRecognition).toEqual({
    service: 'model',
    modelId: 'gemini-live'
  });
});

test('picking a service drops the model id', () => {
  const { onChange } = renderSection({ service: 'model', modelId: 'voxtral' });
  expect(serviceSelect()).toHaveValue('model:voxtral');
  fireEvent.change(serviceSelect(), { target: { value: 'browser' } });
  expect(onChange.mock.calls[0][0].settings.speechRecognition).toEqual({ service: 'browser' });
});

test('flags a model that is no longer offered', () => {
  renderSection({ service: 'model', modelId: 'old-whisper' });
  expect(serviceSelect()).toHaveValue('model:old-whisper');
  expect(screen.getByText(/disabled, no longer exists or does not stream/)).toBeInTheDocument();
});

test('names the platform default model', () => {
  mockPlatformConfig.current = {
    speech: { defaultService: 'model', dictation: { modelId: 'voxtral', available: true } }
  };
  renderSection({ service: 'default' });
  expect(
    screen.getByRole('option', { name: 'Platform default (Voxtral Mini)' })
  ).toBeInTheDocument();
});

describe('voice mode', () => {
  const TTS_MODELS = [
    {
      id: 'voxtral-tts',
      name: { en: 'Voxtral TTS' },
      tts: { voice: 'en_paul_neutral', voices: { de: 'de_anna', fr: 'fr_marie_neutral' } }
    },
    { id: 'gemini-tts', name: { en: 'Gemini TTS' }, tts: { voice: 'Kore' } }
  ];
  const FLAG_ON = { featuresMap: { voiceMode: true } };

  const voiceModeSelect = () => screen.getByLabelText('Voice mode', { selector: 'select' });
  const listeningStyleSelect = () => screen.getByLabelText('Listening style');
  const ttsModelSelect = () => screen.getByLabelText('Text-to-speech model');
  const voiceInput = () => screen.getByLabelText('Voice');
  const optionValues = select => [...select.options].map(o => o.value);

  function renderVoiceMode(app, { ttsModels = TTS_MODELS } = {}) {
    const onChange = jest.fn();
    render(
      <InputModeSection
        app={{ id: 'chat', ...app }}
        onChange={onChange}
        t={t}
        transcriptionModels={MODELS}
        ttsModels={ttsModels}
        currentLanguage="en"
      />
    );
    return { onChange, lastApp: () => onChange.mock.calls.at(-1)[0] };
  }

  /** The app as an editor holds it: every change feeds back into the section. */
  function Harness({ initial, onApp }) {
    const [app, setApp] = useState(initial);
    return (
      <InputModeSection
        app={app}
        onChange={next => {
          setApp(next);
          onApp(next);
        }}
        t={t}
        ttsModels={TTS_MODELS}
        currentLanguage="en"
      />
    );
  }

  test('maps the three-way control to inputMode.voiceMode.enabled', () => {
    renderVoiceMode({});
    expect(voiceModeSelect()).toHaveValue('platform');
    expect(optionValues(voiceModeSelect())).toEqual(['platform', 'on', 'off']);
  });

  test.each([
    [undefined, 'platform'],
    [true, 'on'],
    [false, 'off']
  ])('enabled %s reads as "%s"', (enabled, expected) => {
    renderVoiceMode({ inputMode: { voiceMode: { enabled } } });
    expect(voiceModeSelect()).toHaveValue(expected);
  });

  test('On writes enabled: true and Off writes enabled: false, keeping the rest of inputMode', () => {
    const microphone = { enabled: true, mode: 'manual' };
    const { lastApp } = renderVoiceMode({ inputMode: { type: 'multiline', microphone } });

    fireEvent.change(voiceModeSelect(), { target: { value: 'on' } });
    expect(lastApp().inputMode).toEqual({
      type: 'multiline',
      microphone,
      voiceMode: { enabled: true }
    });

    fireEvent.change(voiceModeSelect(), { target: { value: 'off' } });
    expect(lastApp().inputMode).toEqual({
      type: 'multiline',
      microphone,
      voiceMode: { enabled: false }
    });
  });

  test('Platform default removes enabled, and voiceMode with it when nothing else is set', () => {
    const { lastApp } = renderVoiceMode({
      inputMode: { microphone: { enabled: true }, voiceMode: { enabled: true } }
    });
    fireEvent.change(voiceModeSelect(), { target: { value: 'platform' } });

    expect(lastApp().inputMode).toEqual({ microphone: { enabled: true } });
    expect(lastApp().inputMode).not.toHaveProperty('voiceMode');
  });

  test('Platform default keeps the overrides that are set', () => {
    const { lastApp } = renderVoiceMode({
      inputMode: { voiceMode: { enabled: false, listeningStyle: 'push-to-talk' } }
    });
    // An app that turned voice mode off shows no overrides; switching back shows them.
    fireEvent.change(voiceModeSelect(), { target: { value: 'platform' } });
    expect(lastApp().inputMode).toEqual({ voiceMode: { listeningStyle: 'push-to-talk' } });
  });

  test('writes the overrides that are picked', () => {
    const { lastApp } = renderVoiceMode({ inputMode: { voiceMode: { enabled: true } } });

    fireEvent.change(listeningStyleSelect(), { target: { value: 'push-to-talk' } });
    expect(lastApp().inputMode.voiceMode).toEqual({
      enabled: true,
      listeningStyle: 'push-to-talk'
    });

    fireEvent.change(ttsModelSelect(), { target: { value: 'gemini-tts' } });
    expect(lastApp().inputMode.voiceMode).toEqual({ enabled: true, ttsModelId: 'gemini-tts' });

    fireEvent.change(voiceInput(), { target: { value: 'Kore' } });
    expect(lastApp().inputMode.voiceMode).toEqual({ enabled: true, voice: 'Kore' });
  });

  test('empty overrides are omitted, never saved as empty strings or objects', () => {
    const { onChange } = renderVoiceMode({
      inputMode: {
        voiceMode: {
          enabled: true,
          listeningStyle: 'hands-free',
          ttsModelId: 'voxtral-tts',
          voice: 'de_anna'
        }
      }
    });

    // The section is controlled and onChange is a mock, so each change starts from the same app.
    fireEvent.change(listeningStyleSelect(), { target: { value: '' } });
    fireEvent.change(ttsModelSelect(), { target: { value: '' } });
    fireEvent.change(voiceInput(), { target: { value: '' } });
    const [style, model, voice] = onChange.mock.calls.map(([app]) => app.inputMode.voiceMode);

    expect(style).toEqual({ enabled: true, ttsModelId: 'voxtral-tts', voice: 'de_anna' });
    expect(model).toEqual({ enabled: true, listeningStyle: 'hands-free', voice: 'de_anna' });
    expect(voice).toEqual({
      enabled: true,
      listeningStyle: 'hands-free',
      ttsModelId: 'voxtral-tts'
    });
  });

  test('a voice of only blanks is not saved', () => {
    const { lastApp } = renderVoiceMode({ inputMode: { voiceMode: { enabled: true } } });
    fireEvent.change(voiceInput(), { target: { value: '   ' } });
    expect(lastApp().inputMode.voiceMode).toEqual({ enabled: true });
  });

  test('setting and clearing an override through the editor leaves a clean config', () => {
    const apps = [];
    render(
      <Harness
        initial={{ id: 'chat', inputMode: { type: 'multiline' } }}
        onApp={a => apps.push(a)}
      />
    );

    fireEvent.change(listeningStyleSelect(), { target: { value: 'push-to-talk' } });
    fireEvent.change(ttsModelSelect(), { target: { value: 'voxtral-tts' } });
    fireEvent.change(voiceInput(), { target: { value: 'de_anna' } });
    expect(apps.at(-1).inputMode).toEqual({
      type: 'multiline',
      voiceMode: { listeningStyle: 'push-to-talk', ttsModelId: 'voxtral-tts', voice: 'de_anna' }
    });

    fireEvent.change(listeningStyleSelect(), { target: { value: '' } });
    fireEvent.change(ttsModelSelect(), { target: { value: '' } });
    fireEvent.change(voiceInput(), { target: { value: '' } });
    expect(apps.at(-1).inputMode).toEqual({ type: 'multiline' });
    expect(JSON.stringify(apps.at(-1))).not.toContain('voiceMode');
  });

  test('an app that turned voice mode off shows no overrides', () => {
    renderVoiceMode({ inputMode: { voiceMode: { enabled: false } } });
    expect(screen.getByText('Voice mode is not offered in this app.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Listening style')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Text-to-speech model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Voice')).not.toBeInTheDocument();
  });

  test('offers the text-to-speech models, and flags one that is gone', () => {
    renderVoiceMode({ inputMode: { voiceMode: { ttsModelId: 'old-tts' } } });
    expect(optionValues(ttsModelSelect())).toEqual(['', 'old-tts', 'voxtral-tts', 'gemini-tts']);
    expect(ttsModelSelect()).toHaveValue('old-tts');
    expect(
      screen.getByText(/This model is disabled or no longer exists, so voice mode is not offered/)
    ).toBeInTheDocument();
  });

  test('does not call the model gone while the list is still loading', () => {
    renderVoiceMode(
      { inputMode: { voiceMode: { ttsModelId: 'voxtral-tts' } } },
      { ttsModels: null }
    );
    expect(optionValues(ttsModelSelect())).toEqual(['', 'voxtral-tts']);
    expect(ttsModelSelect()).toHaveValue('voxtral-tts');
    expect(
      screen.queryByText(/This model is disabled or no longer exists/)
    ).not.toBeInTheDocument();
  });

  test('suggests the voices of the picked model', () => {
    renderVoiceMode({ inputMode: { voiceMode: { ttsModelId: 'voxtral-tts' } } });
    const list = document.getElementById(voiceInput().getAttribute('list'));
    expect([...list.options].map(o => o.value)).toEqual([
      'en_paul_neutral',
      'de_anna',
      'fr_marie_neutral'
    ]);
  });

  test('names what the platform default is', () => {
    mockPlatformConfig.current = {
      speech: {
        voiceMode: { appDefault: true, listeningStyle: 'push-to-talk', ttsModelId: 'gemini-tts' }
      }
    };
    renderVoiceMode({});
    expect(screen.getByRole('option', { name: 'Platform default (on)' })).toBeInTheDocument();
    expect(
      within(listeningStyleSelect()).getByRole('option', {
        name: 'Platform default (Push-to-talk)'
      })
    ).toBeInTheDocument();
    expect(
      within(ttsModelSelect()).getByRole('option', { name: 'Platform default (Gemini TTS)' })
    ).toBeInTheDocument();
  });

  describe('microphone', () => {
    test.each([
      ['inputMode.microphone.enabled', { inputMode: { microphone: { enabled: false } } }],
      ['the legacy microphone.enabled', { microphone: { enabled: false } }]
    ])('off (%s): greys out the control and explains why', (_name, app) => {
      renderVoiceMode(app);

      expect(screen.getByTestId('voice-mode-mic-off')).toHaveTextContent(
        'Voice mode needs voice input. Enable the microphone above to use it in this app.'
      );
      expect(voiceModeSelect()).toBeDisabled();
      expect(listeningStyleSelect()).toBeDisabled();
      expect(ttsModelSelect()).toBeDisabled();
      expect(voiceInput()).toBeDisabled();
      expect(voiceModeSelect().closest('fieldset')).toHaveClass('opacity-50');
    });

    test('on: the control is usable and there is no note', () => {
      renderVoiceMode({ inputMode: { microphone: { enabled: true } } });
      expect(screen.queryByTestId('voice-mode-mic-off')).not.toBeInTheDocument();
      expect(voiceModeSelect()).toBeEnabled();
    });

    test('inputMode.microphone.enabled wins over the legacy field', () => {
      renderVoiceMode({
        inputMode: { microphone: { enabled: true } },
        microphone: { enabled: false }
      });
      expect(voiceModeSelect()).toBeEnabled();
    });

    test('turning the microphone off keeps the voice mode settings that were made', () => {
      const { lastApp } = renderVoiceMode({
        inputMode: { microphone: { enabled: true }, voiceMode: { enabled: true } }
      });
      // The microphone switch is the first checkbox of the section.
      fireEvent.click(screen.getAllByRole('checkbox')[0]);
      expect(lastApp().inputMode).toEqual({
        microphone: { enabled: false },
        voiceMode: { enabled: true }
      });
    });
  });

  describe('feature flag', () => {
    test('off: points out the preview feature', () => {
      renderVoiceMode({});
      expect(screen.getByTestId('voice-mode-flag-off')).toHaveTextContent(
        'Voice mode is a preview feature that is switched off under Admin → Features.'
      );
    });

    test('on: no hint', () => {
      mockPlatformConfig.current = FLAG_ON;
      renderVoiceMode({});
      expect(screen.queryByTestId('voice-mode-flag-off')).not.toBeInTheDocument();
    });
  });
});
