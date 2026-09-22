import { describe, it, expect } from '@jest/globals';
import { translateModelTestMessage } from '../../../client/src/features/admin/utils/modelTestMessages';

// Stand-in for i18next's `t`: returns a value derived from the key alone,
// proving whether the key or the fallback was actually used.
const t = key => `translated(${key})`;

describe('translateModelTestMessage', () => {
  it('translates a known messageKey instead of using the raw fallback text', () => {
    expect(translateModelTestMessage(t, 'connectionTimeout', 'Connection timeout')).toBe(
      'translated(admin.models.testResults.messages.connectionTimeout)'
    );
  });

  it('covers every messageKey the backend can send', () => {
    const keys = [
      'testSuccessful',
      'testFailed',
      'connectionTimeout',
      'connectionRefused',
      'serviceNotFound',
      'networkError',
      'requestTimeout',
      'apiKeyNotConfigured',
      'accessDenied',
      'authenticationFailed',
      'modelNotFound',
      'rateLimitExceeded',
      'serverError'
    ];
    for (const key of keys) {
      expect(translateModelTestMessage(t, key, 'fallback')).toBe(
        `translated(admin.models.testResults.messages.${key})`
      );
    }
  });

  it('falls back to the raw message for an unrecognized key (e.g. an older server build)', () => {
    expect(translateModelTestMessage(t, 'somethingNewTheClientDoesNotKnow', 'raw text')).toBe(
      'raw text'
    );
  });

  it('falls back to the raw message when no key is present at all', () => {
    expect(translateModelTestMessage(t, undefined, 'raw text')).toBe('raw text');
  });
});
