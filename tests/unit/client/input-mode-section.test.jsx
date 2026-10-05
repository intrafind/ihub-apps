import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * App editor → Input Mode & Microphone: an app's voice input can be the
 * platform default, the browser, Azure Speech or any enabled transcription
 * model. A model choice is stored as `service: "model"` plus its `modelId`.
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
  expect(screen.getByText(/disabled or no longer exists/)).toBeInTheDocument();
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
