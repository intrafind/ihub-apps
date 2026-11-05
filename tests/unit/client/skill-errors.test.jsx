// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  skillErrorCode,
  skillErrorMessage
} from '../../../client/src/features/skills/utils/skillErrors';

const t = (key, options) => (typeof options === 'string' ? options : options?.defaultValue || key);
const failed = data => ({ originalError: { response: { data } }, originalMessage: 'server text' });

describe('skill API errors', () => {
  it('reads the code from the top level of the response body', () => {
    expect(skillErrorCode(failed({ error: 'x', code: 'SKILL_LIMIT_REACHED' }))).toBe(
      'SKILL_LIMIT_REACHED'
    );
  });

  it('still reads details.code, which the admin skill routes send', () => {
    expect(skillErrorCode(failed({ error: 'x', details: { code: 'SKILL_NAME_TAKEN' } }))).toBe(
      'SKILL_NAME_TAKEN'
    );
  });

  it('words the limit with the number from details', () => {
    const message = skillErrorMessage(
      failed({ code: 'SKILL_LIMIT_REACHED', details: { limit: 5 } }),
      (key, options) => options.defaultValue.replace('{{limit}}', options.limit)
    );
    expect(message).toMatch(/maximum of 5 skills/);
  });

  it('keeps the server text for a code it has no message for', () => {
    expect(skillErrorMessage(failed({ code: 'NOT_FOUND' }), t)).toBe('server text');
  });
});
