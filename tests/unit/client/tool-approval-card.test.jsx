// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ApprovalCard, {
  formatApprovalArgs
} from '../../../client/src/features/chat/components/ApprovalCard';
import {
  buildToolApproval,
  projectRunToMessage
} from '../../../client/src/features/chat/runToMessage';
import { isToolApprovalInteraction } from '../../../client/src/shared/run/interactionToCheckpoint';
import {
  approvalChanged,
  approvalPayload,
  normalizeApproval,
  withActionMode,
  withDefaultMode
} from '../../../client/src/features/admin/components/integrations/installationApproval';
import ToolApprovalConfig, {
  toolApprovalFromForm
} from '../../../client/src/features/admin/components/ToolApprovalConfig';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';
import { toolApprovalAnswer } from '../../../client/src/features/chat/toolApprovalAnswer';

/**
 * The chat's approval card for a tool call (#2945): it shows the exact
 * arguments as text (never markup), the tool and its integration, what the
 * call does and where its data goes, the model's own words labelled as such,
 * and the three decisions. Plus the run projection that feeds it and the
 * admin helpers that edit an installation's approval.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => {
    const t = (key, fallback, values) => {
      if (typeof fallback !== 'string') return key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
    };
    return { t, i18n: { language: 'en' } };
  }
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn()
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="icon" />
}));

const APPROVAL = {
  interactionId: 'approve-1',
  status: 'pending',
  toolId: 'jira__comment',
  toolName: 'Add comment',
  integration: { id: 'jira', name: 'Jira (EU)', action: 'comment' },
  sideEffect: 'write',
  dataFlow: 'external',
  args: { issueKey: 'ACME-12', body: '<img src=x onerror=alert(1)>Tested on staging.' },
  justification: 'I will note the test result on the ticket.'
};

describe('ApprovalCard', () => {
  it('shows tool, integration, effect, data flow and the exact arguments as escaped text', () => {
    const { container } = render(<ApprovalCard approval={APPROVAL} onDecide={() => {}} />);
    expect(screen.getByRole('heading', { name: /Jira \(EU\) · Add comment/ })).toBeInTheDocument();
    expect(screen.getByText('Writes')).toBeInTheDocument();
    expect(screen.getByText('External')).toBeInTheDocument();
    const args = screen.getByTestId('tool-approval-args');
    expect(args.textContent).toBe(formatApprovalArgs(APPROVAL.args));
    expect(args.textContent).toContain('"issueKey": "ACME-12"');
    // A model-written argument is text, never markup.
    expect(container.querySelector('img')).toBeNull();
    expect(args.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows the arguments before the model-written justification, labelled as such', () => {
    render(<ApprovalCard approval={APPROVAL} onDecide={() => {}} />);
    const args = screen.getByTestId('tool-approval-args');
    const justification = screen.getByTestId('tool-approval-justification');
    expect(
      args.compareDocumentPosition(justification) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(justification).toHaveTextContent(/Written by the assistant \(not a verified reason\)/);
    expect(justification).toHaveTextContent(APPROVAL.justification);
  });

  it('answers approve, approve for this chat and reject with the interaction id', () => {
    const onDecide = jest.fn();
    render(<ApprovalCard approval={APPROVAL} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve & allow for this chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide.mock.calls.map(([answer]) => answer)).toEqual([
      { interactionId: 'approve-1', decision: 'approve' },
      { interactionId: 'approve-1', decision: 'approve', grant: 'chat' },
      { interactionId: 'approve-1', decision: 'reject' }
    ]);
  });

  it('takes keyboard focus when it asks, so the decision is the next thing reached', () => {
    render(<ApprovalCard approval={APPROVAL} onDecide={() => {}} />);
    expect(screen.getByTestId('tool-approval-card')).toHaveFocus();
    expect(screen.getByTestId('tool-approval-card')).toHaveAttribute('aria-labelledby');
  });

  it('for an MCP App view call offers no chat-wide grant (allowChatGrant=false)', () => {
    const onDecide = jest.fn();
    render(<ApprovalCard approval={APPROVAL} onDecide={onDecide} allowChatGrant={false} />);
    expect(screen.queryByRole('button', { name: 'Approve & allow for this chat' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith({ interactionId: 'approve-1', decision: 'approve' });
  });

  it('shows the decision instead of the buttons once answered, and is read-only without a handler', () => {
    const { rerender } = render(
      <ApprovalCard approval={{ ...APPROVAL, decision: 'rejected' }} onDecide={() => {}} />
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('tool-approval-decision')).toHaveTextContent(/rejected this call/);
    rerender(<ApprovalCard approval={APPROVAL} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<ApprovalCard approval={{ ...APPROVAL, status: 'expired' }} onDecide={() => {}} />);
    expect(screen.getByText(/This approval expired/)).toBeInTheDocument();
  });
});

describe('run projection of a chat tool approval', () => {
  const interaction = {
    id: 'approve-1',
    kind: 'approval',
    origin: 'tool',
    status: 'pending',
    prompt: {
      message: 'Run?',
      displayData: {
        toolId: 'jira__comment',
        toolName: 'Add comment',
        integration: { id: 'jira', name: 'Jira (EU)' },
        sideEffect: 'write',
        dataFlow: 'external',
        args: { issueKey: 'ACME-12' }
      }
    },
    policy: { expiresAt: '2026-11-03T10:00:00.000Z' },
    source: { chatId: 'chat-1', toolCallId: 'call_1', toolId: 'jira__comment' }
  };

  it('recognizes chat approvals only (not scheduled runs, not workflow checkpoints)', () => {
    expect(isToolApprovalInteraction(interaction)).toBe(true);
    expect(isToolApprovalInteraction({ ...interaction, origin: 'policy' })).toBe(false);
    expect(
      isToolApprovalInteraction({
        ...interaction,
        source: { ...interaction.source, checkpointId: 'ckpt' }
      })
    ).toBe(false);
  });

  it('builds the card data from the interaction', () => {
    expect(buildToolApproval(interaction)).toMatchObject({
      interactionId: 'approve-1',
      toolName: 'Add comment',
      integration: { name: 'Jira (EU)' },
      args: { issueKey: 'ACME-12' },
      expiresAt: '2026-11-03T10:00:00.000Z'
    });
  });

  it('a paused run waiting for approval hands control back to the user', () => {
    const run = {
      runId: 'chat-1',
      status: 'paused',
      text: '',
      interactions: { [interaction.id]: interaction },
      interactionOrder: [interaction.id],
      tools: []
    };
    const projected = projectRunToMessage(run);
    expect(projected.extras.toolApproval.interactionId).toBe('approve-1');
    expect(projected.extras.awaitingInput).toBe(true);
    expect(projected.loading).toBe(false);
  });
});

describe('what a decision on the card sends', () => {
  it('carries "allow for this chat" with an approval, and only then', () => {
    expect(
      toolApprovalAnswer({ interactionId: 'a-1', decision: 'approve', grant: 'chat' })
    ).toEqual({
      outcome: 'approvedForChat',
      approvalResponse: { interactionId: 'a-1', decision: 'approve', grant: 'chat' }
    });
    expect(toolApprovalAnswer({ interactionId: 'a-1', decision: 'approve' })).toEqual({
      outcome: 'approved',
      approvalResponse: { interactionId: 'a-1', decision: 'approve' }
    });
    expect(toolApprovalAnswer({ interactionId: 'a-1', decision: 'reject', grant: 'chat' })).toEqual(
      {
        outcome: 'rejected',
        approvalResponse: { interactionId: 'a-1', decision: 'reject' }
      }
    );
    expect(toolApprovalAnswer({ interactionId: 'a-1', decision: 'maybe' })).toBeNull();
    expect(toolApprovalAnswer({ decision: 'approve' })).toBeNull();
  });
});

describe('installation approval editing', () => {
  it('orders actions by code unit, so a draft equals what is stored whatever the key order', () => {
    expect(
      Object.keys(normalizeApproval({ actions: { b: 'always', B: 'writes', a: 'always' } }).actions)
    ).toEqual(['B', 'a', 'b']);
    expect(
      approvalChanged(
        { actions: { b: 'always', a: 'always' } },
        normalizeApproval({ actions: { a: 'always', b: 'always' } })
      )
    ).toBe(false);
  });

  it('sets and clears the default and per-action modes, keyed by the action name', () => {
    let draft = normalizeApproval(null);
    expect(approvalPayload(draft)).toBeNull();
    draft = withDefaultMode(draft, 'writes');
    draft = withActionMode(draft, 'create_issue', 'always');
    expect(approvalPayload(draft)).toEqual({
      default: 'writes',
      actions: { create_issue: 'always' }
    });
    expect(approvalChanged(null, draft)).toBe(true);
    expect(approvalChanged({ default: 'writes', actions: { create_issue: 'always' } }, draft)).toBe(
      false
    );
    draft = withActionMode(draft, 'create_issue', undefined);
    expect(approvalPayload(draft)).toEqual({ default: 'writes' });
    expect(normalizeApproval({ default: 'sometimes', actions: { a: 'bad' } })).toEqual({
      actions: {}
    });
  });

  it('the platform form leaves unset defaults out and removes an empty block', () => {
    expect(toolApprovalFromForm({ default: '', internal: '', external: 'writes' })).toEqual({
      defaults: { external: 'writes' }
    });
    expect(toolApprovalFromForm({ default: '', internal: '', external: '' })).toBeNull();
  });

  it('the platform form saves only its own block, never the redacted platform config', async () => {
    // The GET answer leaves out secrets such as a proxy JWT provider's jwkUrl;
    // posting it back would write the platform config without them.
    makeAdminApiCall.mockReset();
    makeAdminApiCall.mockImplementation(async (_url, { method } = {}) =>
      method === 'POST'
        ? { data: {} }
        : {
            data: {
              proxyAuth: { jwtProviders: [{ name: 'sso', header: 'X-Token' }] },
              toolApproval: { defaults: { external: 'writes' } }
            }
          }
    );
    render(<ToolApprovalConfig />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(makeAdminApiCall).toHaveBeenCalledWith(
        '/admin/configs/platform',
        expect.objectContaining({ method: 'POST' })
      )
    );
    const post = makeAdminApiCall.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(post[1].body).toEqual({ toolApproval: { defaults: { external: 'writes' } } });
  });
});
