// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the chat page says about a message while iHub is working (#3191):
 *
 * - whether it offers the running composer at all (`composerWhileRunning`):
 *   only with the feature on and the server's `maySteer === true`, not in a
 *   comparison, not while a recording is transcribed;
 * - the notice of a message that was not delivered (`DroppedMessageNotices`):
 *   its text, the reason the server named, Copy to input and Close;
 * - why a message was not sent (`notSentText`), in the person's language by the
 *   problem code, never the server's English detail.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import fs from 'node:fs';
import path from 'node:path';
import DroppedMessageNotices, {
  droppedReasonText
} from '../../../client/src/features/chat/components/DroppedMessageNotices';
import {
  composerWhileRunning,
  withCopiedText
} from '../../../client/src/features/chat/composerWhileRunning';
import { notSentText } from '../../../client/src/features/chat/hooks/useRunSteering';
import { STEER_DROP_REASONS } from '../../../shared/runEvents.js';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultOrOptions, maybeOptions) => {
      const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
      const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
      return Object.entries(options).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
        text
      );
    }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchChat: jest.fn(),
  removeHumanEvent: jest.fn(),
  sendHumanEvent: jest.fn()
}));

/** `t` that answers with the key, to see which text was picked. */
const keyOf = key => key;

const locale = lang =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../shared/i18n/${lang}.json`), 'utf8'));
const lookup = (dict, key) => key.split('.').reduce((node, part) => node?.[part], dict);

describe('whether the chat page offers the running composer', () => {
  const base = {
    steeringEnabled: true,
    maySteer: true,
    compareModeActive: false,
    isTranscribing: false,
    runningRunId: 'run-1',
    clarificationPending: false,
    full: false,
    onSteer: jest.fn(),
    onSendAfter: jest.fn()
  };

  test('with the feature on and the server saying so, it does', () => {
    expect(composerWhileRunning(base)).toEqual({
      enabled: true,
      ready: true,
      blockedReason: null,
      full: false,
      onSteer: base.onSteer,
      onSendAfter: base.onSendAfter
    });
  });

  test.each([
    ['the feature is off', { steeringEnabled: false }],
    ['maySteer is absent (the feature is off on the server)', { maySteer: undefined }],
    ['maySteer is not yet known', { maySteer: null }],
    ['the server says no', { maySteer: false }],
    ['a comparison runs', { compareModeActive: true }],
    ['a recording is transcribed', { isTranscribing: true }]
  ])('not when %s: the composer keeps its single button', (_label, change) => {
    expect(composerWhileRunning({ ...base, ...change })).toBeNull();
  });

  test('before the run started there is nothing to send into; a question above blocks it', () => {
    expect(composerWhileRunning({ ...base, runningRunId: null }).ready).toBe(false);
    expect(composerWhileRunning({ ...base, clarificationPending: true }).blockedReason).toBe(
      'question'
    );
    expect(composerWhileRunning({ ...base, full: true }).full).toBe(true);
  });

  test('the chat page hands the composer what this function decides', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../client/src/features/apps/pages/AppChat.jsx'),
      'utf8'
    );
    expect(source).toMatch(/const whileRunning = composerWhileRunning\(\{/);
    expect(source).toMatch(/^\s*whileRunning,$/m);
  });
});

describe('Copy to input', () => {
  test('adds the text below what is typed, never in its place', () => {
    expect(withCopiedText('', 'Use 2025')).toBe('Use 2025');
    expect(withCopiedText('Draft', 'Use 2025')).toBe('Draft\nUse 2025');
  });
});

describe('the notice of a message that was not delivered', () => {
  test('shows the text and the reason; Copy to input and Close call back with the item', () => {
    const onCopy = jest.fn();
    const onDismiss = jest.fn();
    const item = { id: 's1', text: 'Use the 2025 numbers, not 2024', reason: 'run_stopped' };
    render(<DroppedMessageNotices items={[item]} onCopy={onCopy} onDismiss={onDismiss} />);
    const notice = screen.getByTestId('dropped-message');
    expect(notice).toHaveTextContent('Not delivered: Use the 2025 numbers, not 2024');
    expect(notice).toHaveTextContent('The answer was stopped.');
    expect(screen.getByRole('list', { name: 'Messages not delivered' })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy to input: Use the 2025 numbers, not 2024' })
    );
    expect(onCopy).toHaveBeenCalledWith(item);
    fireEvent.click(
      screen.getByRole('button', { name: 'Close notice: Use the 2025 numbers, not 2024' })
    );
    expect(onDismiss).toHaveBeenCalledWith('s1');
  });

  test('a long text is shortened in the notice and in the names of its buttons', () => {
    const long = 'word '.repeat(40).trim();
    render(
      <DroppedMessageNotices
        items={[{ id: 's2', text: long, reason: null }]}
        onCopy={jest.fn()}
        onDismiss={jest.fn()}
      />
    );
    const copy = screen.getByRole('button', { name: /^Copy to input: / });
    expect(copy.getAttribute('aria-label').length).toBeLessThan(long.length);
    expect(copy.getAttribute('aria-label').endsWith('…')).toBe(true);
  });

  test('renders nothing without items', () => {
    const { container } = render(
      <DroppedMessageNotices items={[]} onCopy={jest.fn()} onDismiss={jest.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('each reason the server names has its own text in en and de; an unknown one the general text', () => {
    const en = locale('en');
    const de = locale('de');
    const shown = STEER_DROP_REASONS.filter(reason => reason !== 'removed');
    const keys = shown.map(reason => droppedReasonText(keyOf, reason));
    // `run_ended` and an unknown reason share the general text; every other reason its own.
    expect(droppedReasonText(keyOf, 'run_ended')).toBe('chat.steer.dropped.ended');
    expect(droppedReasonText(keyOf, 'something_new')).toBe('chat.steer.dropped.ended');
    expect(new Set(keys).size).toBe(shown.length);
    for (const key of keys) {
      expect([key, typeof lookup(en, key)]).toEqual([key, 'string']);
      expect([key, typeof lookup(de, key)]).toEqual([key, 'string']);
    }
  });
});

describe('why a message was not sent', () => {
  test.each([
    [{ status: 403, code: 'RUN_STEER_FORBIDDEN' }, 'chat.steer.notSentForbidden'],
    [{ status: 409, code: 'RUN_NOT_ACTIVE' }, 'chat.steer.notSentApproval'],
    [{ status: 400, code: 'VALIDATION_ERROR' }, 'chat.steer.notSentInvalid'],
    [{ status: 429 }, 'chat.steer.notSentTooMany'],
    [{ status: 503 }, 'chat.steer.notSentBusy'],
    [{ message: 'Network Error' }, 'chat.steer.notSentRetry'],
    [null, 'chat.steer.notSentRetry']
  ])('%j → %s, in en and de', (error, key) => {
    expect(notSentText(keyOf, error)).toBe(key);
    expect(typeof lookup(locale('en'), key)).toBe('string');
    expect(typeof lookup(locale('de'), key)).toBe('string');
  });

  test('never shows the server detail', () => {
    const text = notSentText((key, def) => def, {
      status: 500,
      message: 'Internal detail in English'
    });
    expect(text).toBe('Not sent. Please try again.');
  });
});
