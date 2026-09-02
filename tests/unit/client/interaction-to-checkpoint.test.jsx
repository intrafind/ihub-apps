/**
 * Unit tests for client/src/shared/run/interactionToCheckpoint.js.
 */
import {
  interactionToCheckpoint,
  isCheckpointInteraction,
  isClarificationInteraction,
  isQuestionCheckpoint
} from '../../../client/src/shared/run/interactionToCheckpoint';

const base = {
  runId: 'wf-exec-1',
  status: 'pending',
  createdAt: '2026-09-02T12:00:00.000Z',
  policy: { expiresAt: null, timeoutMs: null }
};

describe('interactionToCheckpoint', () => {
  test('a question asked inside a node keeps its widget, placeholder, skip flag and validation', () => {
    const cp = interactionToCheckpoint({
      ...base,
      id: 'ckpt-q1',
      kind: 'question',
      origin: 'tool',
      prompt: {
        message: 'Which quarter?',
        inputType: 'number',
        placeholder: 'e.g. 3',
        allowSkip: true,
        validation: { min: 1, max: 4, message: '1 to 4' }
      },
      source: { checkpointId: 'ckpt-q1', executionId: 'wf-exec-1', nodeId: 'research' }
    });
    expect(cp).toMatchObject({
      id: 'ckpt-q1',
      nodeId: 'research',
      type: 'input',
      message: 'Which quarter?',
      inputType: 'number',
      placeholder: 'e.g. 3',
      allowSkip: true,
      validation: { min: 1, max: 4, message: '1 to 4' },
      inputSchema: null
    });
    expect(isCheckpointInteraction({ source: { checkpointId: 'ckpt-q1' } })).toBe(true);
    expect(
      isClarificationInteraction({ kind: 'question', prompt: {}, source: { chatId: 'c' } })
    ).toBe(true);
  });

  test('a multi-select question with a custom entry keeps allowOther and its widget', () => {
    const cp = interactionToCheckpoint({
      ...base,
      id: 'ckpt-q2',
      kind: 'question',
      origin: 'tool',
      prompt: {
        message: 'Which regions?',
        inputType: 'multi_select',
        options: [
          { value: 'eu', label: 'EU' },
          { value: 'us', label: 'US' }
        ],
        allowOther: true,
        allowSkip: false
      },
      source: { checkpointId: 'ckpt-q2', executionId: 'wf-exec-1', nodeId: 'plan' }
    });
    expect(cp.inputType).toBe('multi_select');
    expect(cp.allowOther).toBe(true);
    expect(cp).not.toHaveProperty('allowSkip');
    expect(cp.options).toHaveLength(2);
    expect(isQuestionCheckpoint(cp)).toBe(true);
    expect(isQuestionCheckpoint({ type: 'question' })).toBe(true);
    expect(isQuestionCheckpoint({ type: 'approval' })).toBe(false);
    expect(isQuestionCheckpoint(null)).toBe(false);
  });

  test('an approval checkpoint keeps the legacy shape (no widget fields)', () => {
    const cp = interactionToCheckpoint({
      ...base,
      id: 'ckpt-a1',
      kind: 'approval',
      origin: 'node',
      prompt: {
        message: 'Approve?',
        inputType: 'single_select',
        options: [{ value: 'approve', label: 'Approve' }],
        allowSkip: false
      },
      source: { checkpointId: 'ckpt-a1', executionId: 'wf-exec-1', nodeId: 'review' }
    });
    expect(cp.type).toBe('approval');
    expect(cp.options).toHaveLength(1);
    expect(cp).not.toHaveProperty('inputType');
    expect(cp).not.toHaveProperty('allowSkip');
    expect(cp).not.toHaveProperty('placeholder');
  });
});
