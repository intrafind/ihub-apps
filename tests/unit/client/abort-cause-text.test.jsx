import { abortCauseText } from '../../../client/src/shared/utils/abortCause';
import { reasonText } from '../../../client/src/features/tasks/utils/taskFormat';

// `t` as i18next calls it: a key plus either a default string or options.
const t = (key, options) => {
  const known = {
    'abortCauses.user_stop': 'Stopped from the chat',
    'abortCauses.byYou': 'you',
    'abortCauses.byAdmin': 'an administrator',
    'abortCauses.byUser': 'user {{id}}'
  };
  const text = known[key] ?? (typeof options === 'object' ? options.defaultValue : options) ?? key;
  return typeof options === 'object' && options?.id ? text.replace('{{id}}', options.id) : text;
};

const cause = (actor, kind = 'user_stop') => ({ kind, message: 'Stopped (server text)', actor });

test('the person who stopped it reads "you"', () => {
  expect(abortCauseText(t, cause({ type: 'user', id: 'u1' }), { userId: 'u1' })).toBe(
    'Stopped from the chat (you)'
  );
});

test('another user is named only to an administrator', () => {
  const stopped = cause({ type: 'user', id: 'u2' });
  expect(abortCauseText(t, stopped, { userId: 'u1' })).toBe('Stopped from the chat');
  expect(abortCauseText(t, stopped, { userId: 'u1', isAdmin: true })).toBe(
    'Stopped from the chat (user u2)'
  );
});

test('an administrator acting on someone else’s work is said so, and the system adds nothing', () => {
  expect(abortCauseText(t, cause({ type: 'admin' }), {})).toBe(
    'Stopped from the chat (an administrator)'
  );
  expect(abortCauseText(t, cause({ type: 'system' }), {})).toBe('Stopped from the chat');
});

test('a kind this client has no wording for falls back to the server’s sentence', () => {
  expect(abortCauseText(t, cause({ type: 'system' }, 'from_the_future'), {})).toBe(
    'Stopped (server text)'
  );
});

test('no cause, no text', () => {
  expect(abortCauseText(t, null)).toBe('');
});

test('a stopped run reads its cause instead of "The run was stopped"', () => {
  const reason = {
    code: 'ABORTED',
    message: 'Stopped from the chat',
    cause: cause({ type: 'user', id: 'u1' })
  };
  expect(reasonText(t, reason, { userId: 'u1' })).toBe('Stopped from the chat (you)');
  // A run from before causes were recorded keeps its reason.
  expect(reasonText(t, { code: 'ABORTED', message: 'The run was stopped' })).toBe(
    'The run was stopped'
  );
});
