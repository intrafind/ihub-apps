// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createStreamState,
  getRun,
  getRuns,
  reduceRunEvents
} from '../../../shared/run/runReducer.js';
import { projectMessageRuns } from '../../../client/src/features/chat/runToMessage';
import {
  isCheckpointInteraction,
  isClarificationInteraction,
  isMcpElicitationInteraction
} from '../../../client/src/shared/run/interactionToCheckpoint';
import McpElicitationCard, {
  formAnswer
} from '../../../client/src/features/chat/components/McpElicitationCard';
import { answerInteraction } from '../../../client/src/api';

/**
 * A question an MCP server asks mid-call (elicitation) shows as a form card in
 * the chat message while the turn keeps running, and its answer goes to the
 * interaction's endpoint, not into the conversation.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback, values) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''))
        : key,
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/utils/debugLog', () => ({ __esModule: true, debugLog: () => {} }));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  answerInteraction: jest.fn(async () => ({}))
}));

const FORM = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Project name', minLength: 3 },
    seats: { type: 'integer', title: 'Seats', minimum: 1 },
    confirm: { type: 'boolean', title: 'I accept the cost' },
    region: {
      type: 'string',
      title: 'Region',
      oneOf: [
        { const: 'eu', title: 'Europe' },
        { const: 'us', title: 'USA' }
      ]
    }
  },
  required: ['name', 'confirm']
};

const INTERACTION = {
  id: 'elicit-1',
  runId: 'chat-child',
  step: 0,
  kind: 'question',
  origin: 'tool',
  status: 'pending',
  createdAt: '2026-11-26T10:00:00.000Z',
  prompt: {
    title: 'Supabase',
    message: 'Create the paid project for $25/month?',
    inputType: 'form',
    inputSchema: FORM,
    options: [{ value: 'accept', label: 'Submit' }],
    allowSkip: true
  },
  policy: {},
  source: {
    chatId: 'chat-1',
    checkpointId: 'elicit-1',
    executionId: 'chat-child',
    mcpElicitation: { serverId: 'supabase', serverName: 'Supabase' }
  }
};

const env = (seq, type, data, runId) => ({
  v: 2,
  seq,
  runId,
  ts: `2026-11-26T10:00:${String(seq).padStart(2, '0')}.000Z`,
  type,
  data
});

/** The chat run, and the child run the question is raised on. */
const FRAMES = [
  env(1, 'run/started', { kind: 'chat', refs: {} }, 'chat-parent'),
  env(2, 'run/started', { kind: 'chat', parentRunId: 'chat-parent', refs: {} }, 'chat-child'),
  env(3, 'interaction/raised', { interaction: INTERACTION }, 'chat-child'),
  env(4, 'run/paused', { reason: 'interaction', interactionId: 'elicit-1' }, 'chat-child')
];

function messageOf(frames) {
  const state = reduceRunEvents(createStreamState('chat-1'), frames);
  const parent = getRun(state, 'chat-parent');
  const children = getRuns(state).filter(run => run.parentRunId === 'chat-parent');
  return projectMessageRuns(parent, children);
}

describe('classifying an MCP server question', () => {
  it('is neither a workflow checkpoint nor an ask_user clarification', () => {
    expect(isMcpElicitationInteraction(INTERACTION)).toBe(true);
    expect(isCheckpointInteraction(INTERACTION)).toBe(false);
    expect(isClarificationInteraction(INTERACTION)).toBe(false);
  });

  it('puts the pending question on the chat message and keeps it loading', () => {
    const { extras, loading } = messageOf(FRAMES);
    expect(extras.mcpElicitation).toEqual({
      interaction: expect.objectContaining({ id: 'elicit-1' }),
      runId: 'chat-child'
    });
    expect(extras.workflowCheckpoint).toBeUndefined();
    expect(extras.clarification).toBeUndefined();
    expect(loading).toBe(true);
  });

  it('drops the card once the question is answered', () => {
    const { extras } = messageOf([
      ...FRAMES,
      env(5, 'run/resumed', { interactionId: 'elicit-1' }, 'chat-child'),
      env(6, 'run/ended', { status: 'completed', finishReason: 'elicitation_accept' }, 'chat-child')
    ]);
    expect(extras.mcpElicitation).toBeNull();
  });
});

describe('formAnswer', () => {
  it('types each value by its schema and names what is missing or out of range', () => {
    expect(formAnswer(FORM, { name: 'Billing', seats: '4', confirm: true, region: 'eu' })).toEqual({
      data: { name: 'Billing', seats: 4, confirm: true, region: 'eu' },
      missing: [],
      invalid: []
    });
    const { missing, invalid, data } = formAnswer(FORM, { name: 'ab', seats: '0' });
    expect(missing).toEqual([]);
    expect(invalid).toEqual(['name', 'seats']);
    expect(data.confirm).toBe(false);
    expect(formAnswer(FORM, {}).missing).toEqual(['name']);
  });
});

describe('the question card', () => {
  beforeEach(() => answerInteraction.mockClear());

  it('shows the server, its message and the fields', () => {
    render(<McpElicitationCard interaction={INTERACTION} runId="chat-child" />);
    expect(screen.getByRole('heading', { name: 'Supabase asks' })).toBeInTheDocument();
    expect(screen.getByText('Create the paid project for $25/month?')).toBeInTheDocument();
    expect(screen.getByLabelText(/Project name/)).toBeInTheDocument();
    expect(screen.getByLabelText('I accept the cost')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Europe' })).toBeInTheDocument();
  });

  it('submits the typed form to the interaction endpoint', async () => {
    render(<McpElicitationCard interaction={INTERACTION} runId="chat-child" />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Billing' } });
    fireEvent.change(screen.getByLabelText(/Seats/), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText('I accept the cost'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(answerInteraction).toHaveBeenCalledWith(
        'chat-child',
        'elicit-1',
        { value: 'accept', data: { name: 'Billing', seats: 4, confirm: true } },
        { channel: 'chat' }
      )
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Answer sent to Supabase.');
  });

  it('does not send a form with a required field left empty', () => {
    render(<McpElicitationCard interaction={INTERACTION} runId="chat-child" />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(answerInteraction).not.toHaveBeenCalled();
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('declines without any of the required fields', async () => {
    render(<McpElicitationCard interaction={INTERACTION} runId="chat-child" />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(answerInteraction).toHaveBeenCalledWith(
        'chat-child',
        'elicit-1',
        { skipped: true },
        { channel: 'chat' }
      )
    );
  });
});
