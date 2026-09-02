/**
 * Unit tests for client/src/features/chat/runToMessage.js — the pure
 * projection of a RunState onto the assistant chat message.
 */
import {
  createStreamState,
  reduceRunEvents,
  getRun
} from '../../../client/src/shared/run/runReducer';
import {
  projectRunToMessage,
  mergeCitationEntries,
  buildWorkflowSteps
} from '../../../client/src/features/chat/runToMessage';

const ts = seq => `2026-09-02T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}, runId = 'run-1') => ({
  v: 2,
  seq,
  runId,
  ts: ts(seq),
  type,
  data
});
const started = env(1, 'run/started', {
  kind: 'chat',
  refs: { chatId: 'chat-1', appId: 'app-1', messageId: 'msg-1' }
});

function runFrom(envelopes) {
  return getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');
}

describe('projectRunToMessage — streaming content', () => {
  test('null run projects to an empty, non-loading message', () => {
    expect(projectRunToMessage(null)).toEqual({ content: '', loading: false, extras: {} });
  });

  test('text, thinking and images while running', () => {
    const run = runFrom([
      started,
      env(2, 'step/delta', { step: 0, kind: 'text', content: 'Hello' }),
      env(3, 'step/delta', { step: 0, kind: 'thinking', content: 'hmm' }),
      env(4, 'step/delta', {
        step: 0,
        kind: 'thinking',
        content: 'plan',
        meta: { name: 'Planning' }
      }),
      env(5, 'step/delta', {
        step: 0,
        kind: 'image',
        image: { mimeType: 'image/png', data: 'AAA', thoughtSignature: 'sig' }
      }),
      env(6, 'step/delta', { step: 0, kind: 'text', content: ' world' })
    ]);
    const { content, loading, extras } = projectRunToMessage(run);
    expect(content).toBe('Hello world');
    expect(loading).toBe(true);
    expect(extras.thoughts).toEqual(['hmm', { name: 'Planning', content: 'plan' }]);
    expect(extras.images).toEqual([
      { mimeType: 'image/png', data: 'AAA', thoughtSignature: 'sig' }
    ]);
    expect(extras.finishReason).toBeUndefined();
    expect(extras.answerSource).toBeUndefined();
  });

  test('completion carries finishReason, answerSource and ifinderMessageId', () => {
    const run = runFrom([
      started,
      env(2, 'step/delta', { step: 0, kind: 'text', content: 'Answer' }),
      env(3, 'meta', { responseMessageId: 'resp-9', title: 'A title' }),
      env(4, 'tool/completed', {
        step: 0,
        callId: 'c1',
        toolId: 'sources',
        name: 'sources',
        resultPreview: null,
        knowledgeSource: 'sources'
      }),
      env(5, 'run/ended', {
        status: 'completed',
        finishReason: 'stop',
        knowledgeSources: ['websearch']
      })
    ]);
    const { content, loading, extras } = projectRunToMessage(run);
    expect(content).toBe('Answer');
    expect(loading).toBe(false);
    expect(extras.finishReason).toBe('stop');
    expect(extras.answerSource).toEqual({ sources: ['sources', 'websearch'], type: 'mixed' });
    expect(extras.ifinderMessageId).toBe('resp-9');
  });

  test('a stream/error appends the message (legacy error path) and stops loading', () => {
    const run = runFrom([
      started,
      env(2, 'step/delta', { step: 0, kind: 'text', content: 'partial' }),
      env(3, 'stream/error', { code: 'LLM_ERROR', message: 'Boom', retryable: false })
    ]);
    const { content, loading } = projectRunToMessage(run);
    expect(content).toBe('partial\n\nBoom');
    expect(loading).toBe(false);

    const noMessage = runFrom([started, env(2, 'stream/error', { code: 'X', message: '' })]);
    expect(projectRunToMessage(noMessage, { fallbackErrorMessage: 'Fallback' }).content).toBe(
      '\n\nFallback'
    );
  });
});

describe('projectRunToMessage — clarification', () => {
  const interaction = {
    id: 'q-7',
    runId: 'run-1',
    step: 1,
    kind: 'question',
    origin: 'tool',
    prompt: {
      message: 'Which region?',
      inputType: 'single_select',
      options: [{ value: 'eu', label: 'EU' }],
      allowSkip: true,
      allowOther: true,
      context: 'Needed for pricing',
      placeholder: 'Pick one'
    },
    policy: {},
    status: 'pending',
    source: { toolCallId: 'call-3', toolId: 'ask_user', chatId: 'chat-1', appId: 'app-1' },
    createdAt: ts(2),
    ordinal: 2
  };

  test('pending question → clarification + awaitingInput; paused turn stops loading', () => {
    const raised = runFrom([started, env(2, 'interaction/raised', { interaction })]);
    let projected = projectRunToMessage(raised);
    expect(projected.loading).toBe(true);
    expect(projected.extras.awaitingInput).toBe(true);
    expect(projected.extras.clarification).toEqual({
      questionId: 'q-7',
      toolCallId: 'call-3',
      question: 'Which region?',
      inputType: 'single_select',
      options: [{ value: 'eu', label: 'EU' }],
      allowOther: true,
      allowSkip: true,
      context: 'Needed for pricing',
      placeholder: 'Pick one',
      clarificationNumber: 2,
      maxClarifications: undefined
    });

    const paused = runFrom([
      started,
      env(2, 'interaction/raised', { interaction }),
      env(3, 'run/paused', { reason: 'interaction', interactionId: 'q-7' })
    ]);
    projected = projectRunToMessage(paused);
    expect(projected.loading).toBe(false);
    expect(projected.extras.awaitingInput).toBe(true);
    expect(projected.extras.clarificationAnswered).toBeUndefined();
  });

  test('answered question → clarificationAnswered, no longer awaiting input', () => {
    const run = runFrom([
      started,
      env(2, 'interaction/raised', { interaction }),
      env(3, 'run/paused', { reason: 'interaction', interactionId: 'q-7' }),
      env(4, 'interaction/answered', {
        interactionId: 'q-7',
        kind: 'question',
        answer: { value: 'eu', by: 'user', at: ts(4), channel: 'chat' }
      })
    ]);
    const { extras } = projectRunToMessage(run);
    expect(extras.awaitingInput).toBe(false);
    expect(extras.clarificationAnswered).toBe(true);
    expect(extras.clarification.questionId).toBe('q-7');
  });

  test('an answered interaction without a prompt (answer echoed on a new run) is ignored', () => {
    const run = runFrom([
      started,
      env(2, 'interaction/answered', {
        interactionId: 'q-old',
        kind: 'question',
        answer: { value: 'x', by: 'user', at: ts(2), channel: 'chat' }
      })
    ]);
    expect(projectRunToMessage(run).extras.clarification).toBeUndefined();
  });
});

describe('projectRunToMessage — chat-launched workflow', () => {
  const checkpoint = {
    id: 'ckpt-1',
    runId: 'run-1',
    step: 0,
    kind: 'approval',
    origin: 'node',
    prompt: {
      message: 'Approve the plan?',
      title: 'Plan review',
      inputType: 'single_select',
      options: [
        { value: 'approve', label: 'Approve', style: 'primary' },
        { value: 'reject', label: 'Reject', style: 'danger' }
      ],
      inputSchema: null,
      showData: ['$.data.plan'],
      displayData: { data_plan: 'Step 1' },
      allowSkip: false,
      allowOther: false
    },
    policy: { expiresAt: null, timeoutMs: null, onTimeout: 'fail', fallback: 'park' },
    status: 'pending',
    source: {
      nodeId: 'review',
      nodeName: 'Review',
      executionId: 'wf-exec-1',
      chatId: 'chat-1',
      checkpointId: 'ckpt-1'
    },
    createdAt: ts(3)
  };

  test('steps follow appendWorkflowStep semantics and track the running step', () => {
    const node = (seq, nodeName, status, extra = {}) =>
      env(seq, 'progress/node', {
        executionId: 'wf-exec-1',
        nodeId: nodeName.toLowerCase(),
        nodeName,
        nodeType: 'prompt',
        status,
        progress: { workflowName: 'Research', chatVisible: true },
        ...extra
      });
    const run = runFrom([
      started,
      node(2, 'Search', 'running'),
      node(3, 'Draft', 'running'),
      node(4, 'Draft', 'completed'),
      node(5, 'Verify', 'failed', { error: 'boom' })
    ]);
    const steps = buildWorkflowSteps(run);
    expect(steps).toEqual([
      {
        nodeName: 'Search',
        nodeType: 'prompt',
        status: 'completed',
        workflowName: 'Research',
        chatVisible: true
      },
      {
        nodeName: 'Draft',
        nodeType: 'prompt',
        status: 'completed',
        workflowName: 'Research',
        chatVisible: true
      },
      {
        nodeName: 'Verify',
        nodeType: 'prompt',
        status: 'error',
        workflowName: 'Research',
        chatVisible: true
      }
    ]);
    const { extras } = projectRunToMessage(run);
    expect(extras.workflowSteps).toEqual(steps);
    expect(extras.workflowStep).toBeNull();

    const running = runFrom([started, node(2, 'Search', 'running')]);
    expect(projectRunToMessage(running).extras.workflowStep).toMatchObject({
      nodeName: 'Search',
      status: 'running'
    });
  });

  test('checkpoint interaction → workflowCheckpoint (spinner kept while paused), null once answered', () => {
    const paused = runFrom([
      started,
      env(2, 'progress/node', {
        nodeId: 'review',
        nodeName: 'Review',
        nodeType: 'human',
        status: 'running',
        progress: { workflowName: 'Research', chatVisible: true }
      }),
      env(3, 'interaction/raised', { interaction: checkpoint }),
      env(4, 'run/paused', { reason: 'interaction', interactionId: 'ckpt-1' })
    ]);
    const projected = projectRunToMessage(paused);
    expect(projected.loading).toBe(true);
    expect(projected.extras.awaitingInput).toBeUndefined();
    expect(projected.extras.clarification).toBeUndefined();
    expect(projected.extras.workflowCheckpoint).toEqual({
      executionId: 'wf-exec-1',
      checkpoint: {
        id: 'ckpt-1',
        nodeId: 'review',
        nodeName: 'Review',
        type: 'approval',
        message: 'Approve the plan?',
        title: 'Plan review',
        options: checkpoint.prompt.options,
        inputSchema: null,
        showData: ['$.data.plan'],
        displayData: { data_plan: 'Step 1' },
        expiresAt: null,
        timeout: null,
        createdAt: ts(3)
      }
    });

    const answered = runFrom([
      started,
      env(2, 'interaction/raised', { interaction: checkpoint }),
      env(3, 'run/paused', { reason: 'interaction', interactionId: 'ckpt-1' }),
      env(4, 'interaction/answered', {
        interactionId: 'ckpt-1',
        kind: 'approval',
        answer: { value: 'approve', by: 'user', at: ts(4), channel: 'chat' }
      }),
      env(5, 'run/resumed', { interactionId: 'ckpt-1' })
    ]);
    expect(projectRunToMessage(answered).extras.workflowCheckpoint).toBeNull();
  });

  test('meta.extra.workflow finalises steps and sets workflowResult / outputFormat', () => {
    const run = runFrom([
      started,
      env(2, 'progress/node', {
        nodeId: 'search',
        nodeName: 'Search',
        nodeType: 'tool',
        status: 'running',
        progress: { workflowName: 'Research', chatVisible: true }
      }),
      env(3, 'meta', {
        executionId: 'wf-exec-1',
        extra: { workflow: { status: 'failed', workflowName: 'Research', outputFormat: 'html' } }
      })
    ]);
    const { extras } = projectRunToMessage(run);
    expect(extras.workflowSteps).toEqual([
      {
        nodeName: 'Search',
        nodeType: 'tool',
        status: 'error',
        workflowName: 'Research',
        chatVisible: true
      }
    ]);
    expect(extras.workflowStep).toBeNull();
    expect(extras.workflowCheckpoint).toBeNull();
    expect(extras.workflowResult).toEqual({
      status: 'failed',
      executionId: 'wf-exec-1',
      workflowName: 'Research'
    });
    expect(extras.outputFormat).toBe('html');

    const completed = runFrom([
      started,
      env(2, 'meta', {
        executionId: 'wf-exec-2',
        extra: { workflow: { status: 'completed', workflowName: 'R' } }
      })
    ]);
    expect(projectRunToMessage(completed).extras.outputFormat).toBe('markdown');
  });
});

describe('projectRunToMessage — tool side channels', () => {
  test('skills, search status and merged citations', () => {
    const run = runFrom([
      started,
      env(2, 'tool/progress', {
        phase: 'skill.activation',
        message: 'Research',
        data: { skillName: 'Research', description: 'Deep research' }
      }),
      env(3, 'tool/progress', { phase: 'search.status', data: { phase: 'searching', query: 'x' } }),
      env(4, 'tool/progress', { phase: 'citation', data: { references: [{ id: 'r1' }] } }),
      env(5, 'step/completed', {
        step: 0,
        content: '',
        toolCalls: [],
        finishReason: null,
        citations: { resultItems: [{ id: 'i1' }] }
      })
    ]);
    const { extras } = projectRunToMessage(run);
    expect(extras.activeSkills).toEqual([{ name: 'Research', description: 'Deep research' }]);
    expect(extras.searchStatus).toEqual({ phase: 'searching', query: 'x' });
    expect(extras.citations).toEqual({ references: [{ id: 'r1' }], resultItems: [{ id: 'i1' }] });
  });

  test('mergeCitationEntries mirrors useChatMessages.mergeCitations', () => {
    expect(mergeCitationEntries([])).toBeNull();
    expect(
      mergeCitationEntries([
        { references: [1], resultItems: [1] },
        { references: [2] },
        { resultItems: [3] }
      ])
    ).toEqual({ references: [2], resultItems: [3] });
  });
});
