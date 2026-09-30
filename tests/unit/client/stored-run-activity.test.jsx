import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { buildRunActivity } from '../../../shared/run/runActivity.js';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';
import WorkflowStepIndicator from '../../../client/src/features/chat/components/WorkflowStepIndicator';

/**
 * A reopened answer shows what its run did — searches, documents, tool calls,
 * workflow steps and the answer's source — exactly as it showed them live.
 *
 * The server stores `shared/run/runActivity.buildRunActivity` of the run with
 * the answer; the client restores it in `transformStoredMessage`. Both halves
 * are checked against the live projection (`runToMessage`) of the same frames.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'de' }
  })
}));
// `debugLog` reads `import.meta`, which this jest setup cannot load.
jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const env = (seq, type, data = {}, runId = 'run-1') => ({
  v: 2,
  seq,
  runId,
  ts: `2026-09-30T10:00:${String(seq).padStart(2, '0')}.000Z`,
  type,
  data
});

/** A turn that searched the web and iFinder, with an iAssistant search status. */
const SEARCHING_TURN = [
  env(1, 'run/started', { kind: 'chat', refs: {} }),
  env(2, 'tool/started', {
    step: 0,
    callId: 'c1',
    toolId: 'braveSearch',
    name: 'braveSearch',
    args: { query: 'wind power', count: 5 }
  }),
  env(3, 'tool/completed', {
    step: 0,
    callId: 'c1',
    toolId: 'braveSearch',
    name: 'braveSearch',
    durationMs: 10,
    knowledgeSource: 'websearch',
    webSources: [{ url: 'https://example.org', title: 'Example' }]
  }),
  env(4, 'tool/progress', {
    step: 0,
    phase: 'search.status',
    data: { event: 'search.started', queries: ['Windpark'] }
  }),
  env(5, 'tool/progress', {
    step: 0,
    phase: 'search.status',
    data: { event: 'search.finished', numberOfHits: 7 }
  }),
  env(6, 'step/delta', { step: 1, kind: 'text', content: 'The answer.' }),
  env(7, 'run/ended', { status: 'completed', finishReason: 'stop' })
];

/** An @mention workflow run with two steps. */
const WORKFLOW_RUN = [
  env(1, 'run/started', { kind: 'workflow', refs: {} }, 'wf-1'),
  env(
    2,
    'progress/node',
    {
      executionId: 'wf-1',
      nodeId: 'a',
      nodeName: 'Read document',
      nodeType: 'prompt',
      status: 'running',
      progress: { workflowName: 'Review', chatVisible: true }
    },
    'wf-1'
  ),
  env(
    3,
    'progress/node',
    {
      executionId: 'wf-1',
      nodeId: 'b',
      nodeName: 'Write report',
      nodeType: 'prompt',
      status: 'running',
      progress: { workflowName: 'Review', chatVisible: true }
    },
    'wf-1'
  ),
  env(
    4,
    'meta',
    {
      executionId: 'wf-1',
      extra: { workflow: { status: 'completed', workflowName: 'Review', outputFormat: 'markdown' } }
    },
    'wf-1'
  ),
  env(5, 'step/delta', { step: 0, kind: 'text', content: 'Report' }, 'wf-1'),
  env(6, 'run/ended', { status: 'completed', finishReason: 'stop' }, 'wf-1')
];

function runOf(frames, runId = 'run-1') {
  return getRun(reduceRunEvents(createStreamState('chat-1'), frames), runId);
}

/** The message a reopened chat shows for a stored answer carrying `activity`. */
function reopened(activity) {
  return transformStoredMessage({
    id: 'm1',
    role: 'assistant',
    content: 'The answer.',
    runId: 'run-1',
    activity
  });
}

describe('a stored answer shows what its run did', () => {
  test('the searches and tool calls, as they were shown live', () => {
    const run = runOf(SEARCHING_TURN);
    const live = projectRunToMessage(run).extras;
    const message = reopened(buildRunActivity(run));

    expect(message.toolActivity).toEqual(live.toolActivity);
    expect(message.toolActivity.items[0]).toMatchObject({
      kind: 'search',
      query: 'wind power',
      status: 'completed'
    });
    expect(message.searchSummary).toEqual(live.searchSummary);
    expect(message.searchSummary.totalHits).toBe(7);
    // The badge says what the answer was based on, not "AI knowledge".
    expect(message.answerSource).toEqual(live.answerSource);
    expect(message.answerSource.sources).toEqual(['websearch']);
  });

  test('the steps and the result of a workflow', () => {
    const run = runOf(WORKFLOW_RUN, 'wf-1');
    const live = projectRunToMessage(run).extras;
    const message = reopened(buildRunActivity(run));

    expect(message.workflowSteps).toEqual(live.workflowSteps);
    expect(message.workflowSteps.map(s => s.status)).toEqual(['completed', 'completed']);
    expect(message.workflowResult).toEqual(live.workflowResult);
    expect(message.workflowResult.executionId).toBe('wf-1');
    expect(message.outputFormat).toBe('markdown');
  });

  test('nothing for an answer stored without activity', () => {
    const message = reopened(undefined);
    expect(message.toolActivity).toBeUndefined();
    expect(message.workflowSteps).toBeUndefined();
    expect(message.answerSource).toBeUndefined();
  });
});

describe('a finished workflow in the chat', () => {
  test('names the workflow in the viewer’s language and links its execution', () => {
    render(
      <MemoryRouter>
        <WorkflowStepIndicator
          steps={[{ nodeName: 'Read document', status: 'completed' }]}
          result={{
            status: 'failed',
            executionId: 'wf-1',
            workflowName: { en: 'Statement review', de: 'Stellungnahmen-Prüfung' }
          }}
          loading={false}
        />
      </MemoryRouter>
    );
    expect(screen.getByText('Stellungnahmen-Prüfung')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View execution details' })).toHaveAttribute(
      'href',
      '/workflows/executions/wf-1'
    );
  });
});
