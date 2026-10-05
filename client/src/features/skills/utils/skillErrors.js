/**
 * The response body of a failed skills API call, whichever way the error
 * reached us: wrapped by `handleApiResponse` (`originalError.response`) or as
 * the raw axios error (`response`).
 *
 * @param {Error} error - Error thrown by an API call.
 * @returns {Object|null}
 */
function responseData(error) {
  return error?.originalError?.response?.data || error?.response?.data || null;
}

/**
 * The error code the skills API put in `details.code`, if any.
 *
 * @param {Error} error - Error thrown by an API call.
 * @returns {string|null}
 */
export function skillErrorCode(error) {
  const data = responseData(error);
  return data?.details?.code || data?.code || error?.code || null;
}

/**
 * A message for a failed skill call a user can act on. The server's own
 * wording is kept where there is no better one — the generic 403 text of the
 * API client would hide *why* an action was refused.
 *
 * @param {Error} error - Error thrown by an API call.
 * @param {Function} t - i18next `t`.
 * @returns {string}
 */
export function skillErrorMessage(error, t) {
  switch (skillErrorCode(error)) {
    case 'REVISION_CONFLICT':
      return t(
        'skills.errors.conflict',
        'Someone else changed this skill in the meantime. Close the editor and open it again to see the latest version.'
      );
    case 'SKILL_LIMIT_REACHED': {
      const limit = responseData(error)?.details?.limit;
      return limit
        ? t('skills.errors.limitCount', {
            defaultValue:
              'You have reached the maximum of {{limit}} skills. Delete one to make room.',
            limit
          })
        : t(
            'skills.errors.limit',
            'You have reached the maximum number of skills. Delete one to make room.'
          );
    }
    case 'SKILL_TOO_LARGE':
      return t(
        'skills.errors.tooLarge',
        'This skill is too large. Shorten the instructions or remove files.'
      );
    case 'SKILL_NAME_TAKEN':
      return t(
        'skills.errors.nameTaken',
        'A global skill with this name already exists. Choose another name.'
      );
    case 'SKILL_ACCESS_CHANGED':
      return t(
        'skills.errors.accessChanged',
        'Your access to this skill has changed. Reload the page to see what you may do now.'
      );
    case 'SKILL_FORBIDDEN':
      return t('skills.errors.forbidden', 'You are not allowed to do this with this skill.');
    case 'SHARE_TARGET_NOT_ALLOWED':
      return t(
        'skills.errors.shareNotAllowed',
        'You are not allowed to share skills with this audience.'
      );
    case 'USER_SKILLS_UNAVAILABLE':
      return t(
        'skills.errors.unavailable',
        'Your skills are unavailable right now. Please try again later.'
      );
    case 'USER_SKILLS_DISABLED':
      return t('skills.errors.disabled', 'Personal skills are switched off.');
    case 'USER_SKILLS_NOT_ALLOWED':
      return t('skills.errors.notAllowed', 'Sign in to keep skills of your own.');
    default:
      return (
        error?.originalMessage ||
        responseData(error)?.error ||
        error?.message ||
        t('skills.errors.generic', 'Something went wrong. Please try again.')
      );
  }
}
