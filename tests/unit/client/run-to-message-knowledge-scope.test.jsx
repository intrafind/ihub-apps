// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `knowledge/scope` frame of a run reaches the message the client
 * renders (#1036): the badge of a freshly streamed answer, not only of a
 * stored one.
 */
import { createStreamState, getRun, reduceRunEvents } from '../../../shared/run/runReducer.js';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';

const env = (seq, type, data = {}) => ({
  v: 2,
  seq,
  runId: 'run-1',
  ts: `2026-10-21T10:00:${String(seq).padStart(2, '0')}.000Z`,
  type,
  data
});

describe('projectRunToMessage — knowledge scope', () => {
  test('forwards the scope of the turn onto the message', () => {
    const scope = {
      budgetTokens: 40000,
      projects: [{ id: 'prj_1', name: 'Case', mode: 'loaded', documents: 2, tokens: 120 }]
    };
    const run = getRun(
      reduceRunEvents(createStreamState('chat-1'), [
        env(1, 'run/started', { kind: 'chat', refs: { chatId: 'chat-1', appId: 'app-1' } }),
        env(2, 'knowledge/scope', scope),
        env(3, 'text/delta', { text: 'Hello' }),
        env(4, 'run/ended', { status: 'completed', finishReason: 'stop' })
      ]),
      'run-1'
    );
    expect(run.knowledgeScope).toEqual(scope);
    const { extras } = projectRunToMessage(run);
    expect(extras.knowledgeScope).toEqual(scope);
  });

  test('sets nothing when the turn reached no project', () => {
    const run = getRun(
      reduceRunEvents(createStreamState('chat-1'), [
        env(1, 'run/started', { kind: 'chat', refs: { chatId: 'chat-1', appId: 'app-1' } })
      ]),
      'run-1'
    );
    const { extras } = projectRunToMessage(run);
    expect(extras.knowledgeScope).toBeUndefined();
  });
});
