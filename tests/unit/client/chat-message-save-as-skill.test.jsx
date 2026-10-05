import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

/**
 * "Save as skill" under an answer that drafts a skill — a SKILL.md in a code
 * block, as the skill-builder skill hands it over. The button hands the draft
 * to the page, which opens the skill editor filled in. It is offered only on
 * a finished answer that holds a draft, and only where the page passes the
 * handler (the user may keep skills of their own).
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) =>
      typeof options === 'string'
        ? options
        : (options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name]),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { featuresMap: {} } })
}));

jest.mock('../../../client/src/api', () => ({
  sendMessageFeedback: jest.fn(),
  answerInteraction: jest.fn()
}));

jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="content">{content}</div>
}));

jest.mock('../../../client/src/shared/components/CustomResponseRenderer', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: { get: jest.fn(), post: jest.fn() },
  default: { get: jest.fn(), post: jest.fn() }
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`,
  buildAssetUrl: path => path,
  buildPath: path => path
}));

const DRAFT_ANSWER = [
  'Here is the draft:',
  '',
  '````markdown',
  '---',
  'name: meeting-minutes',
  'description: "Writes meeting minutes from notes. Use when the user asks for minutes."',
  '---',
  '',
  '# Meeting minutes',
  '',
  'Follow `references/template.md`.',
  '````',
  '',
  '```markdown references/template.md',
  '## Decisions',
  '```'
].join('\n');

/**
 * Render one message (an answer with a draft by default) and return the
 * `onSaveAsSkill` handler it was given.
 */
function renderAnswer({ content = DRAFT_ANSWER, onSaveAsSkill = jest.fn(), ...message } = {}) {
  render(
    <ChatMessage
      message={{ id: 'msg-1', role: 'assistant', content, ...message }}
      appId="chat"
      chatId="chat-1"
      modelId="m"
      onSaveAsSkill={onSaveAsSkill}
    />
  );
  return onSaveAsSkill;
}

describe('ChatMessage "Save as skill"', () => {
  it('hands the drafted skill, with its files, to the page', () => {
    const onSaveAsSkill = renderAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Save as skill: meeting-minutes' }));
    expect(onSaveAsSkill).toHaveBeenCalledWith({
      name: 'meeting-minutes',
      description: 'Writes meeting minutes from notes. Use when the user asks for minutes.',
      body: '# Meeting minutes\n\nFollow `references/template.md`.',
      files: [{ path: 'references/template.md', content: '## Decisions' }]
    });
  });

  it('is not offered on an answer without a draft, or one still streaming', () => {
    renderAnswer({ content: 'Paris is the capital of France.' });
    renderAnswer({ loading: true });
    expect(screen.queryByText('Save as skill')).not.toBeInTheDocument();
  });

  it('is not offered on the user’s own message or without the handler', () => {
    renderAnswer({ role: 'user' });
    renderAnswer({ onSaveAsSkill: null });
    expect(screen.queryByText('Save as skill')).not.toBeInTheDocument();
  });
});
