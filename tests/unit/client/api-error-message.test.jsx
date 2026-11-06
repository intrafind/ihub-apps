// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiErrorMessage } from '../../../client/src/utils/apiErrorMessage';

const t = key => (key === 'apiErrors.CHAT_TEMPORARY' ? 'Keep the chat first.' : key);

const failed = data => ({ response: { data }, message: 'Request failed with status code 409' });

describe('apiErrorMessage', () => {
  it('localizes a specific code from its i18n key', () => {
    const error = failed({ detail: 'A temporary chat cannot be shared', code: 'CHAT_TEMPORARY' });
    expect(apiErrorMessage(error, t, 'fallback')).toBe('Keep the chat first.');
  });

  it('shows the English text of a generic code', () => {
    const error = failed({ detail: 'Some recipients are not known users', code: 'BAD_REQUEST' });
    expect(apiErrorMessage(error, t, 'fallback')).toBe('Some recipients are not known users');
  });

  it('falls back to the response text when the code has no translation', () => {
    const error = failed({ detail: 'Plain text', code: 'NOT_IN_I18N' });
    expect(apiErrorMessage(error, t, 'fallback')).toBe('Plain text');
  });

  it('falls back to the error message, then to the fallback', () => {
    expect(apiErrorMessage(new Error('Network Error'), t, 'fallback')).toBe('Network Error');
    expect(apiErrorMessage({}, t, 'fallback')).toBe('fallback');
  });
});
