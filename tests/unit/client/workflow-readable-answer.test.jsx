import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { workflowAnswerView } from '../../../client/src/features/workflows/utils/readableWorkflowAnswer.js';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

/**
 * A workflow that answers with its whole output as JSON (no result selected,
 * `wholeOutput` on its result) is shown in the web chat in the answer's output
 * format; the stored answer stays JSON. An answer the workflow chose itself is
 * never reformatted.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : fallback?.defaultValue || key;
      const values = typeof fallback === 'object' ? fallback : options || {};
      return Object.entries(values).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
        text
      );
    },
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

jest.mock('../../../client/src/api/endpoints/sources', () => ({
  __esModule: true,
  fetchSourceContent: jest.fn(),
  fetchSourceMetadata: jest.fn(() => Promise.resolve({}))
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

jest.mock('../../../client/src/features/workflows/components/AppSelectionModal', () => ({
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

jest.mock('../../../client/src/features/chat/components/WorkflowStepIndicator', () => ({
  __esModule: true,
  default: () => null
}));

const output = { bericht: '| V1 | ok |', corrected_text: 'Fixed text.', _userHint: 'x' };
const json = JSON.stringify(output, null, 2);

const wholeOutput = { status: 'completed', wholeOutput: true };
const view = (content, format, workflowResult = wholeOutput) =>
  workflowAnswerView({ content, workflowResult }, format);

describe('workflowAnswerView', () => {
  it('shows one Markdown section per output, leaving engine fields out', () => {
    expect(view(json, 'markdown')).toEqual({
      text: '### bericht\n\n| V1 | ok |\n\n### corrected text\n\nFixed text.',
      preserveBreaks: false
    });
  });

  it('shows one "name:" line per output in the text format, keeping line breaks', () => {
    expect(view(json, 'text')).toEqual({
      text: 'bericht:\n| V1 | ok |\n\ncorrected text:\nFixed text.',
      preserveBreaks: true
    });
  });

  it('shows a single output on its own', () => {
    const single = JSON.stringify({ corrected_text: 'Fixed text.', _userHint: 'x' });
    expect(view(single, 'markdown').text).toBe('Fixed text.');
    expect(view(single, 'text').text).toBe('Fixed text.');
  });

  it('shows structured values as JSON, in a code block for Markdown', () => {
    const answer = JSON.stringify({ a: 'x', counts: { v1: 2 }, n: 3 });
    expect(view(answer, 'markdown').text).toBe(
      '### a\n\nx\n\n### counts\n\n```json\n{\n  "v1": 2\n}\n```\n\n### n\n\n3'
    );
    expect(view(answer, 'text').text).toBe('a:\nx\n\ncounts:\n{\n  "v1": 2\n}\n\nn:\n3');
  });

  it('never reformats an answer the workflow chose itself, even when it is JSON', () => {
    // A selected object result is JSON-serialized by the runner, without wholeOutput.
    expect(view(json, 'markdown', { status: 'completed' })).toBeNull();
    expect(view(json, 'markdown', null)).toBeNull();
  });

  it('leaves the JSON format, and anything that is not a JSON object, as it is', () => {
    expect(view(json, 'json')).toBeNull();
    expect(view('Fixed text.', 'markdown')).toBeNull();
    expect(view('{ not json', 'markdown')).toBeNull();
    expect(view('[1, 2]', 'markdown')).toBeNull();
    expect(view('Intro {"a": "b"}', 'markdown')).toBeNull();
  });

  it('has no text when nothing is left to show, instead of showing engine fields', () => {
    expect(view(JSON.stringify({ _userHint: 'x', empty: '' }), 'markdown')).toEqual({
      text: null,
      preserveBreaks: false
    });
  });
});

describe('ChatMessage with a JSON workflow answer', () => {
  const workflowMessage = {
    id: 'msg-wf',
    role: 'assistant',
    content: json,
    workflowResult: {
      status: 'completed',
      executionId: 'wf-1',
      workflowName: 'Rule check',
      wholeOutput: true
    },
    outputFormat: 'markdown'
  };

  // A workflow answer links its execution, so it needs a router.
  const renderMessage = overrides =>
    render(
      <MemoryRouter>
        <ChatMessage
          message={{ ...workflowMessage, ...overrides }}
          appId="chat"
          chatId="chat-1"
          modelId="m"
        />
      </MemoryRouter>
    );

  it('shows the outputs as Markdown sections', () => {
    renderMessage();
    expect(screen.getByTestId('content')).toHaveTextContent('### bericht');
    expect(screen.getByTestId('content')).toHaveTextContent('### corrected text');
    expect(screen.getByTestId('content')).not.toHaveTextContent('_userHint');
  });

  it('shows the outputs as lines that keep their breaks in the text format', () => {
    const { container } = renderMessage({ outputFormat: 'text' });
    // The innermost element holding the answer (document order lists
    // the wrappers first).
    const block = [...container.querySelectorAll('div')]
      .filter(div => div.textContent.startsWith('bericht:'))
      .at(-1);
    expect(block).toBeDefined();
    expect(block.className).toContain('whitespace-pre-wrap');
  });

  it('keeps the JSON format as JSON', () => {
    renderMessage({ outputFormat: 'json' });
    expect(screen.getByTestId('content')).toHaveTextContent('"corrected_text": "Fixed text."');
  });

  it('leaves the same JSON from a model answer untouched', () => {
    renderMessage({ workflowResult: undefined });
    expect(screen.getByTestId('content')).toHaveTextContent('"bericht": "| V1 | ok |"');
  });

  it('leaves a JSON answer the workflow selected itself untouched', () => {
    renderMessage({ workflowResult: { status: 'completed', executionId: 'wf-1' } });
    expect(screen.getByTestId('content')).toHaveTextContent('"bericht": "| V1 | ok |"');
  });

  it('says so when no output is left to show', () => {
    renderMessage({ content: JSON.stringify({ _userHint: 'x' }) });
    expect(screen.getByTestId('content')).toHaveTextContent(
      'The workflow finished without output to show.'
    );
    expect(screen.getByTestId('content')).not.toHaveTextContent('_userHint');
  });
});
