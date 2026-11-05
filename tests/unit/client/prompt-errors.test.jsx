// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  promptErrorCode,
  promptErrorMessage
} from '../../../client/src/features/prompts/utils/promptErrors';

const t = (key, fallback) => fallback || key;
const failed = data => ({ originalError: { response: { data } }, originalMessage: 'server text' });

describe('prompt API errors', () => {
  it('reads the code from the top level of the response body', () => {
    expect(promptErrorCode(failed({ error: 'x', code: 'PROMPT_LIMIT_REACHED' }))).toBe(
      'PROMPT_LIMIT_REACHED'
    );
    expect(promptErrorCode({})).toBeNull();
  });

  it('words the codes the editor knows, and keeps the server text for the rest', () => {
    expect(promptErrorMessage(failed({ code: 'REVISION_CONFLICT' }), t)).toMatch(
      /Someone else changed this prompt/
    );
    expect(promptErrorMessage(failed({ code: 'USER_PROMPTS_DISABLED' }), t)).toBe(
      'Personal prompts are switched off.'
    );
    expect(promptErrorMessage(failed({ code: 'PROMPT_FORBIDDEN' }), t)).toBe('server text');
  });
});
