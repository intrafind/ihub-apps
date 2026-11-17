// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The continuation of the stored call after a connect (#3752), client side:
 * `useConnectResume` asks the server once with the record's id and nothing
 * else, only when the chat reports a record for the integration that was just
 * connected, and only when the chat can take a turn. The old synthetic
 * message path is gone.
 */
import { render, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { useConnectResume } from '../../../client/src/features/integrations/connect/useConnectResume';
import {
  getConnectResumeStatus,
  resetConnectResumeStatusForTests
} from '../../../client/src/features/integrations/connect/connectResumeStatus';
import { resetConnectResultForTests } from '../../../client/src/features/integrations/connect/connectResult';

const RECORD = { id: 'a'.repeat(32), integrations: ['jira'], callIds: ['c1'] };

function Harness(props) {
  useConnectResume({ chatId: 'chat-1', ...props });
  return null;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/apps/a/c/chat-1?integration_connected=jira');
});
afterEach(() => {
  resetConnectResultForTests();
  resetConnectResumeStatusForTests();
  window.history.replaceState(null, '', '/');
});

describe('useConnectResume', () => {
  test('sends the record id once the chat is ready and idle, and nothing else', async () => {
    const resume = jest.fn(() => true);
    const { rerender } = render(
      <Harness pendingConnect={null} ready={false} busy={false} resume={resume} />
    );
    rerender(<Harness pendingConnect={RECORD} ready={false} busy={false} resume={resume} />);
    rerender(<Harness pendingConnect={RECORD} ready busy resume={resume} />);
    expect(resume).not.toHaveBeenCalled();
    rerender(<Harness pendingConnect={RECORD} ready busy={false} resume={resume} />);
    await act(async () => {});
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ id: RECORD.id, integration: 'jira' });
    // One attempt per page: more renders do not send it again.
    rerender(<Harness pendingConnect={{ ...RECORD }} ready busy={false} resume={resume} />);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(getConnectResumeStatus('jira')).toEqual({ state: 'resuming' });
  });

  test('then the card goes back to the plain line when the turn ended', async () => {
    const resume = jest.fn(() => true);
    const { rerender } = render(
      <Harness pendingConnect={RECORD} ready busy={false} resume={resume} />
    );
    await act(async () => {});
    rerender(<Harness pendingConnect={RECORD} ready busy resume={resume} />);
    rerender(<Harness pendingConnect={RECORD} ready busy={false} resume={resume} />);
    expect(getConnectResumeStatus('jira')).toEqual({ state: 'done' });
  });

  test('a chat that turned the request away leaves no "continuing" line', async () => {
    const resume = jest.fn(() => false);
    render(<Harness pendingConnect={RECORD} ready busy={false} resume={resume} />);
    await act(async () => {});
    expect(resume).toHaveBeenCalledTimes(1);
    expect(getConnectResumeStatus('jira')).toBeNull();
  });

  test('nothing without a record for the connected integration (an old card, another integration)', async () => {
    const resume = jest.fn();
    render(<Harness pendingConnect={null} ready busy={false} resume={resume} />);
    render(
      <Harness
        pendingConnect={{ ...RECORD, integrations: ['okta'] }}
        ready
        busy={false}
        resume={resume}
      />
    );
    await act(async () => {});
    expect(resume).not.toHaveBeenCalled();
  });

  test('nothing without a successful connect (cancelled consent, closed tab)', async () => {
    window.history.replaceState(
      null,
      '',
      '/apps/a/c/chat-1?integration_error=access_denied&integration=jira'
    );
    const resume = jest.fn();
    render(<Harness pendingConnect={RECORD} ready busy={false} resume={resume} />);
    await act(async () => {});
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('the synthetic-message path is gone', () => {
  const root = path.resolve(__dirname, '../../..');
  const walk = dir =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
      return /\.(js|jsx|json)$/.test(entry.name) ? [full] : [];
    });

  test('no source or translation mentions useConnectRetry or retryMessage', () => {
    const files = [...walk(path.join(root, 'client/src')), ...walk(path.join(root, 'shared/i18n'))];
    const offenders = files.filter(file =>
      /useConnectRetry|connectRetry|integrations\.connect\.retryMessage|"retryMessage"/.test(
        fs.readFileSync(file, 'utf8')
      )
    );
    expect(offenders).toEqual([]);
  });
});
