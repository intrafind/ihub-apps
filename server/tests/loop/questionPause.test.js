import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuestionCheckpoint,
  pausedLoopState,
  resumeTranscript,
  answeredToolContent
} from '../../services/workflow/questionPause.js';
import { checkpointToInteraction } from '../../services/loop/RunStream.js';
import { interactionSchema } from '../../services/loop/contracts/interaction.js';

const interaction = {
  id: 'ckpt-q1',
  runId: 'wf-exec-1',
  kind: 'question',
  origin: 'tool',
  status: 'pending',
  prompt: {
    message: 'Which quarter should the report cover?',
    inputType: 'text',
    placeholder: 'e.g. Q3 2025',
    allowSkip: true,
    allowOther: false,
    validation: { pattern: '^Q[1-4] 20\\d\\d$', message: 'Quarter like Q3 2025' }
  },
  policy: { fallback: 'park' },
  source: {
    checkpointId: 'ckpt-q1',
    executionId: 'wf-exec-1',
    nodeId: 'research',
    toolCallId: 'call_7'
  },
  createdAt: '2026-09-02T12:00:00.000Z'
};

test('a question checkpoint carries the prompt and round-trips into a question interaction', () => {
  const cp = buildQuestionCheckpoint({
    node: { id: 'research', name: { en: 'Research', de: 'Recherche' } },
    interaction,
    language: 'de'
  });
  assert.equal(cp.type, 'question');
  assert.equal(cp.nodeName, 'Recherche');
  assert.equal(cp.inputType, 'text');
  assert.equal(cp.allowSkip, true);
  assert.equal(cp.placeholder, 'e.g. Q3 2025');
  assert.deepEqual(cp.validation, interaction.prompt.validation);
  assert.equal(cp.inputSchema, null);

  // the SSE projection of `workflow.human.required` keeps it a free-text question
  const projected = checkpointToInteraction(cp, { runId: 'wf-exec-1', executionId: 'wf-exec-1' });
  assert.equal(projected.kind, 'question');
  assert.equal(projected.prompt.inputType, 'text');
  assert.equal(projected.prompt.allowSkip, true);
  assert.equal(projected.prompt.placeholder, 'e.g. Q3 2025');
  assert.equal(projected.source.checkpointId, 'ckpt-q1');
  assert.doesNotThrow(() => interactionSchema.parse(projected));
});

test('resumeTranscript replaces the awaiting ask_user result with the answer (or the skip)', () => {
  const messages = [
    { role: 'user', content: 'Write the report.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_7', function: { name: 'ask_user' } }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_7',
      name: 'ask_user',
      content: JSON.stringify({ status: 'awaiting_user_response', clarificationNumber: 1 })
    }
  ];
  const paused = pausedLoopState({ checkpointId: 'ckpt-q1', toolCallId: 'call_7', messages });
  assert.equal(paused.checkpointId, 'ckpt-q1');

  const answered = resumeTranscript(paused, { value: 'Q3 2025', skipped: false });
  assert.equal(answered.length, 3);
  assert.deepEqual(JSON.parse(answered[2].content), { status: 'answered', answer: 'Q3 2025' });
  assert.equal(answered[0], messages[0], 'other messages untouched');

  const skipped = resumeTranscript(paused, { skipped: true });
  assert.equal(JSON.parse(skipped[2].content).status, 'skipped');
  assert.equal(answeredToolContent({ skipped: true }).includes('skipped'), true);

  // nothing to resume without an answer or a paused loop
  assert.equal(resumeTranscript(paused, null), null);
  assert.equal(resumeTranscript(null, { value: 'x' }), null);

  // the awaiting message was compacted away: the answer still reaches the model
  const compacted = pausedLoopState({
    checkpointId: 'ckpt-q1',
    toolCallId: 'call_7',
    messages: [messages[0]]
  });
  const fallback = resumeTranscript(compacted, { value: 'Q3 2025' });
  assert.equal(fallback.length, 2);
  assert.equal(fallback[1].role, 'user');
  assert.match(fallback[1].content, /Q3 2025/);
});
