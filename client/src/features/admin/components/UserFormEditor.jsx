// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { validatePasswordConfirmation, isFieldRequired } from '../../../utils/schemaValidation';
import {
  FIELD_KEYS,
  RULE_KEYS,
  fieldErrorAttributes,
  fieldErrorId,
  schemaFieldErrors
} from '../utils/fieldErrors';
import useAdminFormErrors from '../hooks/useAdminFormErrors';
import AdminFormErrorFrame from './AdminFormErrorFrame';
import GroupMultiSelect from './GroupMultiSelect';
import { CHECKBOX_CLASS, INPUT_CLASS } from './formStyles';

/** The user fields with texts of their own, by schema rule (`fieldErrors.js`). */
const USER_FIELD_RULES = Object.freeze({
  username: { empty: FIELD_KEYS.usernameRequired, pattern: FIELD_KEYS.usernameFormat }
});

/** The shortest password a local user may get. */
const PASSWORD_MIN_LENGTH = 6;

/**
 * Every problem of a user, in the admin's language, by field path.
 *
 * @param {Object} user - The user as the form holds it.
 * @param {Object|null} schema - The user JSON schema.
 * @param {function} t - The translation function.
 * @param {Object} options
 * @param {boolean} options.needsPassword - A new local user needs a password.
 * @param {string} options.confirmPassword - What the admin typed to confirm it.
 * @returns {Object<string, string>}
 */
export function userFieldErrors(user, schema, t, { needsPassword, confirmPassword }) {
  const errors = schema ? schemaFieldErrors(user, schema, t, { rules: USER_FIELD_RULES }) : {};
  if (!schema) {
    if (!user.username) {
      errors.username = t(FIELD_KEYS.usernameRequired);
    } else if (!/^[a-zA-Z0-9_.-]+$/.test(user.username)) {
      errors.username = t(FIELD_KEYS.usernameFormat);
    }
    // Email is optional for external auth users (NTLM, OIDC, proxy, etc.)
    if (user.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
      errors.email = t(RULE_KEYS.email);
    }
  }

  // Password validation - only required for new local auth users
  if (needsPassword && !user.password) {
    errors.password = t(FIELD_KEYS.passwordRequired);
  } else if (user.password && user.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = t(FIELD_KEYS.passwordMinLength, { min: PASSWORD_MIN_LENGTH });
  }

  if (user.password && validatePasswordConfirmation(user.password, confirmPassword)) {
    errors.confirmPassword = t(FIELD_KEYS.passwordMismatch);
  }
  return errors;
}

/**
 * UserFormEditor - Form-based editor for user configuration
 *
 * A blank user shows no errors: a field says what is wrong once the admin has
 * left or changed it, and every problem shows after the first save attempt.
 *
 * @param {Object} props
 * @param {Object} props.value - The user
 * @param {Function} props.onChange - Receives the changed user
 * @param {Function} [props.onValidationChange] - Receives `{ isValid, errors, displayed }`
 * @param {boolean} [props.showAllErrors] - Show every problem (after a save attempt)
 * @param {number} [props.summaryFocusKey] - A new value moves the focus to the error summary
 */
function UserFormEditor({
  value: user,
  onChange,
  onValidationChange,
  isNewUser = false,
  isSelf = false,
  jsonSchema,
  availableGroups = [],
  showAllErrors = false,
  summaryFocusKey = 0
}) {
  const { t } = useTranslation();
  const [confirmPassword, setConfirmPassword] = useState('');

  // Check if user uses local auth (needs password)
  const isLocalAuthUser =
    !user?.authMethods || user.authMethods.length === 0 || user.authMethods.includes('local');
  const hasExternalAuth = user?.authMethods?.some(m =>
    ['ntlm', 'oidc', 'ldap', 'proxy', 'teams'].includes(m)
  );
  const needsPassword = isNewUser && isLocalAuthUser && !hasExternalAuth;

  const allErrors = useMemo(
    () => (user ? userFieldErrors(user, jsonSchema, t, { needsPassword, confirmPassword }) : {}),
    [user, jsonSchema, t, needsPassword, confirmPassword]
  );
  const { errors: validationErrors, controlHandlers } = useAdminFormErrors(allErrors, {
    showAll: showAllErrors,
    onValidationChange
  });

  const handleInputChange = (field, value) => {
    const updatedUser = {
      ...user,
      [field]: value
    };
    onChange(updatedUser);
  };

  const handleGroupsChange = groupsArray => {
    handleInputChange('internalGroups', groupsArray);
  };

  if (!user) {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        <Icon
          name="exclamation-triangle"
          className="h-12 w-12 mx-auto mb-4 text-gray-500 dark:text-gray-400"
        />
        <p className="text-lg font-medium">
          {t('admin.users.edit.noUserData', 'No user data available')}
        </p>
      </div>
    );
  }

  const errorLabels = {
    username: t('admin.users.fields.username', 'Username'),
    email: t('admin.users.fields.email', 'Email'),
    name: t('admin.users.fields.name', 'Name'),
    password: t('admin.users.fields.password', 'Password'),
    confirmPassword: t('admin.users.fields.confirmPassword', 'Confirm Password')
  };

  return (
    <AdminFormErrorFrame
      className="user-form-editor space-y-6"
      errors={validationErrors}
      controlHandlers={controlHandlers}
      showSummary={showAllErrors}
      labels={errorLabels}
      title={t('admin.users.edit.fixErrors', 'Please fix the following errors')}
      focusKey={summaryFocusKey}
    >
      {/* Basic Information */}
      <div className="bg-white dark:bg-gray-800 shadow-sm dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.users.basicInformation', 'Basic Information')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.users.basicUserConfiguration',
                'Basic user configuration and contact information'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="grid grid-cols-6 gap-6">
              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.users.username', 'Username')}
                  {isFieldRequired('username', jsonSchema) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                <input
                  type="text"
                  name="username"
                  {...fieldErrorAttributes('username', validationErrors.username)}
                  required={isFieldRequired('username', jsonSchema)}
                  value={user.username || ''}
                  onChange={e => handleInputChange('username', e.target.value)}
                  disabled={!isNewUser}
                  className={`${INPUT_CLASS} mt-1 block ${
                    validationErrors.username ? 'border-red-500 dark:border-red-400' : ''
                  }`}
                  placeholder={t('admin.users.form.usernamePlaceholder', 'Enter username')}
                />
                {validationErrors.username && (
                  <p
                    id={fieldErrorId('username')}
                    className="mt-1 text-sm text-red-600 dark:text-red-400"
                  >
                    {validationErrors.username}
                  </p>
                )}
                {!isNewUser && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.users.usernameCannotBeChanged',
                      'Username cannot be changed after creation'
                    )}
                  </p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.users.email', 'Email')}
                  {isFieldRequired('email', jsonSchema) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                <input
                  type="email"
                  name="email"
                  {...fieldErrorAttributes('email', validationErrors.email)}
                  required={isFieldRequired('email', jsonSchema)}
                  value={user.email || ''}
                  onChange={e => handleInputChange('email', e.target.value)}
                  className={`${INPUT_CLASS} mt-1 block ${
                    validationErrors.email ? 'border-red-500 dark:border-red-400' : ''
                  }`}
                  placeholder={t('admin.users.form.emailPlaceholder', 'Enter email address')}
                />
                {validationErrors.email && (
                  <p
                    id={fieldErrorId('email')}
                    className="mt-1 text-sm text-red-600 dark:text-red-400"
                  >
                    {validationErrors.email}
                  </p>
                )}
              </div>

              <div className="col-span-6">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.users.fullName', 'Full Name')}
                </label>
                <input
                  type="text"
                  value={user.fullName || ''}
                  onChange={e => handleInputChange('fullName', e.target.value)}
                  className={`${INPUT_CLASS} mt-1 block`}
                  placeholder={t('admin.users.form.fullNamePlaceholder', 'Enter full name')}
                />
              </div>

              <div className="col-span-6 sm:col-span-3">
                <div className="flex items-center">
                  {/* The stored field is `active`; it is the only one this switch sets.
                        Your own account cannot be deactivated (the server refuses it). */}
                  <input
                    id="user-active"
                    type="checkbox"
                    checked={user.active !== false}
                    disabled={isSelf && user.active !== false}
                    aria-describedby={isSelf ? 'user-active-self-hint' : undefined}
                    onChange={e => handleInputChange('active', e.target.checked)}
                    className={`${CHECKBOX_CLASS} disabled:opacity-50`}
                  />
                  <label
                    htmlFor="user-active"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.users.enabled', 'Enabled')}
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.users.form.enabledHelp',
                    'Disabled users cannot log in or access the system'
                  )}
                </p>
                {isSelf && (
                  <p
                    id="user-active-self-hint"
                    className="mt-1 text-xs text-gray-600 dark:text-gray-300"
                  >
                    {t(
                      'admin.users.edit.selfDeactivateHint',
                      'You cannot deactivate your own account.'
                    )}
                  </p>
                )}
              </div>

              {/* Auth Methods - selector for new users, read-only for existing */}
              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.users.authMethods', 'Authentication Method')}
                </label>
                {isNewUser ? (
                  <>
                    <select
                      value={user.authMethods?.[0] || 'local'}
                      onChange={e => handleInputChange('authMethods', [e.target.value])}
                      className={`${INPUT_CLASS} mt-1 block`}
                    >
                      <option value="local">
                        {t('admin.users.authMethod.local', 'Local (Username/Password)')}
                      </option>
                      <option value="ntlm">
                        {t('admin.users.authMethod.ntlm', 'NTLM (Windows Domain)')}
                      </option>
                      <option value="ldap">{t('admin.users.authMethod.ldap', 'LDAP')}</option>
                      <option value="oidc">
                        {t('admin.users.authMethod.oidc', 'OIDC (OpenID Connect)')}
                      </option>
                      <option value="proxy">
                        {t('admin.users.authMethod.proxy', 'Proxy (Header-based)')}
                      </option>
                    </select>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.users.authMethodHelp',
                        'How this user will authenticate. Local users need a password.'
                      )}
                    </p>
                  </>
                ) : user.authMethods && user.authMethods.length > 0 ? (
                  <>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {user.authMethods.map((method, index) => (
                        <span
                          key={index}
                          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800"
                        >
                          {method.toUpperCase()}
                        </span>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.users.authMethodReadOnly',
                        'Authentication method cannot be changed after creation'
                      )}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {t('admin.users.noAuthMethod', 'No authentication method set')}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Password Settings - only show for local auth users or new users */}
      {(isLocalAuthUser || isNewUser) && (
        <div className="bg-white dark:bg-gray-800 shadow-sm dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
                {t('admin.users.passwordSettings', 'Password Settings')}
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {hasExternalAuth
                  ? t(
                      'admin.users.passwordOptionalExternal',
                      'Optional - user authenticates via external provider'
                    )
                  : isNewUser
                    ? t('admin.users.setInitialPassword', 'Set the initial password for this user')
                    : t('admin.users.changePassword', 'Leave blank to keep current password')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <div className="grid grid-cols-6 gap-6">
                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {isNewUser
                      ? t('admin.users.password', 'Password')
                      : t('admin.users.newPassword', 'New Password')}
                    {isNewUser && isLocalAuthUser && !hasExternalAuth && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </label>
                  <input
                    type="password"
                    name="password"
                    {...fieldErrorAttributes('password', validationErrors.password)}
                    required={needsPassword}
                    value={user.password || ''}
                    onChange={e => handleInputChange('password', e.target.value)}
                    className={`${INPUT_CLASS} mt-1 block ${
                      validationErrors.password ? 'border-red-500 dark:border-red-400' : ''
                    }`}
                    placeholder={
                      hasExternalAuth
                        ? 'Optional - user has external auth'
                        : isNewUser
                          ? 'Enter password'
                          : 'Enter new password (optional)'
                    }
                  />
                  {validationErrors.password && (
                    <p
                      id={fieldErrorId('password')}
                      className="mt-1 text-sm text-red-600 dark:text-red-400"
                    >
                      {validationErrors.password}
                    </p>
                  )}
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.users.confirmPassword', 'Confirm Password')}
                    {user.password && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  <input
                    type="password"
                    name="confirmPassword"
                    {...fieldErrorAttributes('confirmPassword', validationErrors.confirmPassword)}
                    required={!!user.password}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className={`${INPUT_CLASS} mt-1 block ${
                      validationErrors.confirmPassword ? 'border-red-500 dark:border-red-400' : ''
                    }`}
                    placeholder={t('admin.users.confirmPassword', 'Confirm Password')}
                  />
                  {validationErrors.confirmPassword && (
                    <p
                      id={fieldErrorId('confirmPassword')}
                      className="mt-1 text-sm text-red-600 dark:text-red-400"
                    >
                      {validationErrors.confirmPassword}
                    </p>
                  )}
                </div>

                <div className="col-span-6">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.users.form.passwordHelp',
                      'Password must be at least 6 characters long and should contain a mix of letters, numbers, and special characters.'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Group Membership */}
      <div className="bg-white dark:bg-gray-800 shadow-sm dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.users.groupMembership', 'Group Membership')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.users.groupMembershipDescription',
                'Assign this user to groups to control their permissions and access levels'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <GroupMultiSelect
              id="user-internal-groups"
              label={t('admin.users.groups', 'Groups')}
              value={user.internalGroups || []}
              onChange={handleGroupsChange}
              availableGroups={availableGroups}
              placeholder={t('admin.users.groupsPlaceholder', 'Search groups or type a name…')}
              emptyMessage={t('admin.users.groupsEmpty', 'No groups assigned yet')}
              helpText={t(
                'admin.users.groupsHelp',
                'Search and select defined groups, or type a name and press Enter to add an external group mapping. Users inherit permissions from all assigned groups.'
              )}
            />
          </div>
        </div>
      </div>
    </AdminFormErrorFrame>
  );
}

export default UserFormEditor;
