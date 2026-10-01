import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The prompt editor and the share dialog (release follow-up to #2519):
 *  - a prompt is for any app or for one app, chosen explicitly, also when it
 *    starts as "Save as prompt" from a chat in some app;
 *  - placeholders are typed as {{name}} — there is no insert button, only the
 *    hint that says so;
 *  - people and groups are added through one search box, and groups are only
 *    offered for a search, never listed in full.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : fallback?.defaultValue || key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/IconPicker', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({
    apps: [
      { id: 'chat', name: 'Chat', type: 'chat' },
      { id: 'translator', name: 'Translator', type: 'chat' }
    ]
  })
}));

jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));

const mockCreateUserPrompt = jest.fn();
const mockFetchPromptShareTargets = jest.fn();
jest.mock('../../../client/src/api', () => ({
  createUserPrompt: (...args) => mockCreateUserPrompt(...args),
  updateUserPrompt: jest.fn(),
  fetchPromptVariables: jest.fn().mockResolvedValue({ autoNames: ['date'], values: {} }),
  fetchPromptShareTargets: (...args) => mockFetchPromptShareTargets(...args),
  updatePromptShares: jest.fn()
}));

const PromptEditorModal =
  require('../../../client/src/features/prompts/components/PromptEditorModal').default;
const PromptShareDialog =
  require('../../../client/src/features/prompts/components/PromptShareDialog').default;

beforeEach(() => {
  mockCreateUserPrompt.mockReset();
  mockCreateUserPrompt.mockImplementation(async body => ({ id: 'p1', ...body }));
  mockFetchPromptShareTargets.mockReset();
});

async function renderEditor(props) {
  const onSaved = jest.fn();
  await act(async () => {
    render(<PromptEditorModal onClose={() => {}} onSaved={onSaved} {...props} />);
  });
  return onSaved;
}

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
}

describe('PromptEditorModal', () => {
  test('a new prompt is for any app unless an app is chosen', async () => {
    const onSaved = await renderEditor();
    expect(screen.getByRole('radio', { name: /Any app/ })).toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'App' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Status mail' } });
    fireEvent.change(screen.getByLabelText(/^Prompt/), {
      target: { value: 'Write to {{recipient}}' }
    });
    await save();

    expect(mockCreateUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ appId: null }));
    expect(onSaved).toHaveBeenCalled();
  });

  test('"Save as prompt" starts bound to the chat\'s app and can be made available in any app', async () => {
    await renderEditor({ initial: { prompt: 'Translate {{content}}', appId: 'translator' } });
    expect(screen.getByRole('radio', { name: 'A specific app' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveValue('translator');

    fireEvent.click(screen.getByRole('radio', { name: /Any app/ }));
    expect(screen.queryByRole('combobox', { name: 'App' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Translate' } });
    await save();

    expect(mockCreateUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ appId: null }));
  });

  test('binding to an app picks one at once and saves it', async () => {
    await renderEditor({ initial: { prompt: 'Hello' } });
    fireEvent.click(screen.getByRole('radio', { name: 'A specific app' }));
    const select = screen.getByRole('combobox', { name: 'App' });
    expect(select).toHaveValue('chat');
    fireEvent.change(select, { target: { value: 'translator' } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Hi' } });
    await save();

    expect(mockCreateUserPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'translator' })
    );
  });

  test('placeholders are typed, not inserted: no insert button, a hint instead', async () => {
    await renderEditor();
    expect(screen.queryByRole('button', { name: /Insert variable/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Add a placeholder by typing \{\{mytext\}\}/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Prompt/), {
      target: { value: 'Write to {{recipient}} about {{topic}}' }
    });
    expect(screen.getByText('{{recipient}}')).toBeInTheDocument();
    expect(screen.getByText('{{topic}}')).toBeInTheDocument();
  });
});

describe('PromptShareDialog', () => {
  const groups = Array.from({ length: 10 }, (_, i) => ({ id: `team-${i}`, name: `Team ${i}` }));

  async function renderDialog() {
    mockFetchPromptShareTargets.mockImplementation(async query => ({
      allowed: { user: true, group: true, everyone: true },
      users: query.length >= 2 ? [{ id: 'u1', name: 'Grace Hopper', email: 'grace@x' }] : [],
      groups: groups.filter(group => !query || group.name.toLowerCase().includes(query))
    }));
    await act(async () => {
      render(
        <PromptShareDialog
          prompt={{ id: 'p1', name: 'Status mail', shares: [] }}
          onClose={() => {}}
          onSaved={() => {}}
        />
      );
    });
  }

  async function search(text) {
    jest.useFakeTimers();
    try {
      fireEvent.change(screen.getByPlaceholderText('Add people or groups'), {
        target: { value: text }
      });
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
    } finally {
      jest.useRealTimers();
    }
    await act(async () => {});
  }

  test('without a search no group is offered — there is no second group picker', async () => {
    await renderDialog();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Matching people and groups' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Team 1')).not.toBeInTheDocument();
  });

  test('a search offers matching people and groups, and adding one clears it', async () => {
    await renderDialog();
    await search('team');
    const results = screen.getByRole('list', { name: 'Matching people and groups' });
    expect(results).toHaveClass('max-h-48', 'overflow-y-auto');
    expect(screen.getAllByText(/^Team \d$/)).toHaveLength(10);

    await act(async () => {
      fireEvent.click(screen.getByText('Team 3'));
    });
    await act(async () => {});
    expect(screen.getByPlaceholderText('Add people or groups')).toHaveValue('');
    expect(
      screen.queryByRole('list', { name: 'Matching people and groups' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('Team 3')).toBeInTheDocument();
  });
});
