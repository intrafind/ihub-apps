import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * Using a prompt with variables (#2519): the fill-in dialog asks for exactly
 * the placeholders that do not fill themselves in, refuses to go on while a
 * required one is empty, shows the final text as it is typed, and hands back
 * that text — `{{content}}` taken out and the caret put there — without
 * sending anything.
 */

// The automatic variables are cached per language, so a test that must reach
// the server again switches to a language nothing has loaded yet.
let mockLanguage = 'en';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback) =>
      typeof fallback === 'string' ? fallback : fallback?.defaultValue || _key,
    i18n: { language: mockLanguage }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockFetchPromptVariables = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchPromptVariables: (...args) => mockFetchPromptVariables(...args)
}));

const usePromptLauncher =
  require('../../../client/src/features/prompts/hooks/usePromptLauncher').default;

let launcher;
function Harness() {
  launcher = usePromptLauncher();
  return launcher.dialog;
}

beforeEach(() => {
  mockFetchPromptVariables.mockReset();
  mockFetchPromptVariables.mockResolvedValue({
    autoNames: ['user_name', 'date', 'company'],
    values: { user_name: 'Ada', date: 'Tuesday', company: 'ACME' }
  });
});

/**
 * Start a launch and let the dialog render. Returns the launch's promise
 * wrapped, so awaiting this helper does not wait for the dialog to close.
 */
async function launch(prompt, options) {
  let pending;
  await act(async () => {
    pending = launcher.launch(prompt, options);
    // Let the variables request settle and the dialog mount.
    await Promise.resolve();
  });
  return { pending };
}

test('a prompt without user variables resolves at once, globals filled in', async () => {
  render(<Harness />);
  const { pending: p1 } = await launch({
    id: 'p1',
    name: 'Hello',
    prompt: 'Hi {{company}}, {{user_name}} here. Summarize: {{content}}'
  });
  const result = await p1;
  expect(result.text).toBe('Hi ACME, Ada here. Summarize: ');
  expect(result.caret).toBe(result.text.length);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('asks for each user variable, checks required ones and previews the text', async () => {
  render(<Harness />);
  const { pending } = await launch({
    id: 'p2',
    name: 'Email',
    prompt: 'Write a {{tone}} email to {{recipient}} on {{date}}.',
    variables: [
      {
        name: 'tone',
        label: 'Tone',
        type: 'select',
        required: false,
        defaultValue: 'formal',
        predefinedValues: [
          { label: 'Formal', value: 'formal' },
          { label: 'Casual', value: 'casual' }
        ]
      }
    ]
  });

  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText('Tone')).toBeInTheDocument();
  expect(screen.getByLabelText(/Recipient/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Date/)).not.toBeInTheDocument();

  const preview = screen.getByTestId('prompt-variables-preview');
  expect(preview).toHaveTextContent('Write a formal email to {{recipient}} on Tuesday.');

  // Required and empty: submitting is refused and says why.
  fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
  expect(screen.getByRole('alert')).toHaveTextContent('This field is required');

  fireEvent.change(screen.getByLabelText(/Recipient/), { target: { value: 'Grace' } });
  fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'casual' } });
  expect(preview).toHaveTextContent('Write a casual email to Grace on Tuesday.');

  fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
  await expect(pending).resolves.toEqual({
    text: 'Write a casual email to Grace on Tuesday.',
    caret: null,
    appVariables: {}
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('cancelling resolves to null', async () => {
  render(<Harness />);
  const { pending } = await launch({ id: 'p3', name: 'X', prompt: 'About {{topic}}' });
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await expect(pending).resolves.toBeNull();
});

test('a second launch cancels the dialog it replaces', async () => {
  render(<Harness />);
  const { pending: first } = await launch({ id: 'p6', name: 'First', prompt: 'To {{recipient}}' });
  const { pending: second } = await launch({ id: 'p7', name: 'Second', prompt: 'On {{topic}}' });
  await expect(first).resolves.toBeNull();

  fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'tests' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
  await expect(second).resolves.toEqual({ text: 'On tests', caret: null, appVariables: {} });
});

test('declared variables the text does not use go to the app', async () => {
  render(<Harness />);
  const { pending } = await launch(
    {
      id: 'p4',
      name: 'FAQ',
      appId: 'faq-bot',
      prompt: 'Answer: {{content}}',
      variables: [{ name: 'language', label: 'Language', type: 'string', required: true }]
    },
    { includeAppVariables: true }
  );
  fireEvent.change(await screen.findByLabelText(/Language/), { target: { value: 'German' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
  await expect(pending).resolves.toEqual({
    text: 'Answer: ',
    caret: 'Answer: '.length,
    appVariables: { language: 'German' }
  });
});

test('still works when the server cannot resolve the global variables', async () => {
  mockFetchPromptVariables.mockRejectedValue(new Error('offline'));
  // A different language skips the values cached by the tests above.
  mockLanguage = 'fr';
  try {
    render(<Harness />);
    const { pending } = await launch({ id: 'p5', name: 'Y', prompt: 'Today is {{date}}' });
    // `{{date}}` is still known as automatic, so nobody is asked for it; its
    // value is left for the server to fill in when the message is sent.
    await expect(pending).resolves.toEqual({
      text: 'Today is {{date}}',
      caret: null,
      appVariables: {}
    });
    expect(mockFetchPromptVariables).toHaveBeenCalledWith('fr');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  } finally {
    mockLanguage = 'en';
  }
});
