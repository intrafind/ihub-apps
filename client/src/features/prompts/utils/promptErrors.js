/**
 * The error code the prompts API put in `details.code`, if any.
 *
 * @param {Error} error - Error thrown by an API call.
 * @returns {string|null}
 */
export function promptErrorCode(error) {
  return error?.originalError?.response?.data?.details?.code || error?.code || null;
}

/**
 * A message for a failed prompt call a user can act on. The server's own
 * wording is kept where there is no better one — the generic 403 text of the
 * API client would hide *why* an action was refused.
 *
 * @param {Error} error - Error thrown by an API call.
 * @param {Function} t - i18next `t`.
 * @returns {string}
 */
export function promptErrorMessage(error, t) {
  switch (promptErrorCode(error)) {
    case 'REVISION_CONFLICT':
      return t(
        'prompts.errors.conflict',
        'Someone else changed this prompt in the meantime. Close the editor and open it again to see the latest version.'
      );
    case 'PROMPT_LIMIT_REACHED':
      return t(
        'prompts.errors.limit',
        'You have reached the maximum number of prompts. Delete one to make room.'
      );
    case 'SHARE_TARGET_NOT_ALLOWED':
      return t(
        'prompts.errors.shareNotAllowed',
        'You are not allowed to share prompts with this audience.'
      );
    case 'USER_PROMPTS_UNAVAILABLE':
      return t(
        'prompts.errors.unavailable',
        'Your prompts are unavailable right now. Please try again later.'
      );
    case 'USER_PROMPTS_DISABLED':
      return t('prompts.errors.disabled', 'Personal prompts are switched off.');
    default:
      return (
        error?.originalMessage ||
        error?.message ||
        t('prompts.errors.generic', 'Something went wrong. Please try again.')
      );
  }
}
