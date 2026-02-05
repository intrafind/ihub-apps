import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  validateWithSchema,
  errorsToFieldErrors,
  validatePasswordConfirmation,
  isFieldRequired
} from '../../../utils/schemaValidation';

/**
 * UserFormEditor - Form-based editor for user configuration
 */
const UserFormEditor = ({
  value: user,
  onChange,
  onValidationChange,
  isNewUser = false,
  jsonSchema
}) => {
  const { t } = useTranslation();
  const [validationErrors, setValidationErrors] = useState({});
  const [confirmPassword, setConfirmPassword] = useState('');

  // Check if user uses local auth (needs password)
  const isLocalAuthUser =
    !user?.authMethods || user.authMethods.length === 0 || user.authMethods.includes('local');
  const hasExternalAuth = user?.authMethods?.some(m =>
    ['ntlm', 'oidc', 'ldap', 'proxy', 'teams'].includes(m)
  );

  // Validation function
  const validateUser = userData => {
    let errors = {};

    // Use schema validation if available
    if (jsonSchema) {
      const validation = validateWithSchema(userData, jsonSchema);
      if (!validation.isValid) {
        errors = errorsToFieldErrors(validation.errors);
      }
    } else {
      // Fallback to manual validation if no schema
      if (!userData.username) {
        errors.username = t('admin.users.validation.usernameRequired', 'Username is required');
      } else if (!/^[a-zA-Z0-9_.-]+$/.test(userData.username)) {
        errors.username = t(
          'admin.users.validation.usernameInvalid',
          'Username can only contain letters, numbers, periods, hyphens, and underscores'
        );
      }

      // Email is optional for external auth users (NTLM, OIDC, proxy, etc.)
      // Only validate format if email is provided
      if (userData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userData.email)) {
        errors.email = t(
          'admin.users.validation.emailInvalid',
          'Please enter a valid email address'
        );
      }
    }

    // Password validation - only required for new local auth users
    const needsPassword = isNewUser && isLocalAuthUser && !hasExternalAuth;
    if (needsPassword && !userData.password) {
      errors.password = t(
        'admin.users.validation.passwordRequired',
        'Password is required for local authentication'
      );
    } else if (userData.password && userData.password.length > 0 && userData.password.length < 6) {
      errors.password = t(
        'admin.users.validation.passwordTooShort',
        'Password must be at least 6 characters long'
      );
    }

    // Confirm password validation
    if (userData.password) {
      const passwordError = validatePasswordConfirmation(userData.password, confirmPassword);
      if (passwordError) {
        errors.confirmPassword = t('admin.users.validation.passwordMismatch', passwordError);
      }
    }

    setValidationErrors(errors);

    const isValid = Object.keys(errors).length === 0;
    if (onValidationChange) {
      onValidationChange({
        isValid,
        errors: Object.entries(errors).map(([field, message]) => ({
          field,
          message,
          severity: 'error'
        }))
      });
    }

    return isValid;
  };

  // Validate on user changes
  useEffect(() => {
    if (user) {
      validateUser(user);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, confirmPassword, jsonSchema]);

  const handleInputChange = (field, value) => {
    const updatedUser = {
      ...user,
      [field]: value
    };
    onChange(updatedUser);
  };

  const handleGroupsChange = groupsString => {
    const groupsArray = groupsString
      .split(',')
      .map(g => g.trim())
      .filter(g => g.length > 0);

    handleInputChange('groups', groupsArray);
  };

  if (!user) {
    return (
      <div className="p-8 text-center text-gray-500">
        <Icon name="exclamation-triangle" className="h-12 w-12 mx-auto mb-4 text-gray-400" />
        <p className="text-lg font-medium">
          {t('admin.users.edit.noUserData', 'No user data available')}
        </p>
      </div>
    );
  }

  return (
    <div className="user-form-editor space-y-6">
      {/* Basic Information */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.users.basicInformation', 'Basic Information')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t(
                'admin.users.basicUserConfiguration',
                'Basic user configuration and contact information'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="grid grid-cols-6 gap-6">
              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.users.username', 'Username')}
                  {isFieldRequired('username', jsonSchema) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                <input
                  type="text"
                  required={isFieldRequired('username', jsonSchema)}
                  value={user.username || ''}
                  onChange={e => handleInputChange('username', e.target.value)}
                  disabled={!isNewUser}
                  className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm disabled:bg-gray-100 ${
                    validationErrors.username ? 'border-red-300' : ''
                  }`}
                  placeholder="Enter username"
                />
                {validationErrors.username && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.username}</p>
                )}
                {!isNewUser && (
                  <p className="mt-1 text-xs text-gray-500">
                    {t(
                      'admin.users.usernameCannotBeChanged',
                      'Username cannot be changed after creation'
                    )}
                  </p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.users.email', 'Email')}
                  {isFieldRequired('email', jsonSchema) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                <input
                  type="email"
                  required={isFieldRequired('email', jsonSchema)}
                  value={user.email || ''}
                  onChange={e => handleInputChange('email', e.target.value)}
                  className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                    validationErrors.email ? 'border-red-300' : ''
                  }`}
                  placeholder="Enter email address"
                />
                {validationErrors.email && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.email}</p>
                )}
              </div>

              <div className="col-span-6">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.users.fullName', 'Full Name')}
                </label>
                <input
                  type="text"
                  value={user.fullName || ''}
                  onChange={e => handleInputChange('fullName', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  placeholder="Enter full name"
                />
              </div>

              <div className="col-span-6 sm:col-span-3">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={user.enabled !== false && user.active !== false}
                    onChange={e => {
                      handleInputChange('enabled', e.target.checked);
                      handleInputChange('active', e.target.checked);
                    }}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-900">
                    {t('admin.users.enabled', 'Enabled')}
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Disabled users cannot log in or access the system
                </p>
              </div>

              {/* Auth Methods - selector for new users, read-only for existing */}
              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.users.authMethods', 'Authentication Method')}
                </label>
                {isNewUser ? (
                  <>
                    <select
                      value={user.authMethods?.[0] || 'local'}
                      onChange={e => handleInputChange('authMethods', [e.target.value])}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
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
                    <p className="mt-1 text-xs text-gray-500">
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
                    <p className="mt-1 text-xs text-gray-500">
                      {t(
                        'admin.users.authMethodReadOnly',
                        'Authentication method cannot be changed after creation'
                      )}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">
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
        <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900">
                {t('admin.users.passwordSettings', 'Password Settings')}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
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
                  <label className="block text-sm font-medium text-gray-700">
                    {isNewUser
                      ? t('admin.users.password', 'Password')
                      : t('admin.users.newPassword', 'New Password')}
                    {isNewUser && isLocalAuthUser && !hasExternalAuth && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </label>
                  <input
                    type="password"
                    required={isNewUser && isLocalAuthUser && !hasExternalAuth}
                    value={user.password || ''}
                    onChange={e => handleInputChange('password', e.target.value)}
                    className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                      validationErrors.password ? 'border-red-300' : ''
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
                    <p className="mt-1 text-sm text-red-600">{validationErrors.password}</p>
                  )}
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.users.confirmPassword', 'Confirm Password')}
                    {user.password && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  <input
                    type="password"
                    required={!!user.password}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                      validationErrors.confirmPassword ? 'border-red-300' : ''
                    }`}
                    placeholder="Confirm password"
                  />
                  {validationErrors.confirmPassword && (
                    <p className="mt-1 text-sm text-red-600">{validationErrors.confirmPassword}</p>
                  )}
                </div>

                <div className="col-span-6">
                  <p className="text-xs text-gray-500">
                    Password must be at least 6 characters long and should contain a mix of letters,
                    numbers, and special characters.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Group Membership */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.users.groupMembership', 'Group Membership')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Assign this user to groups to control their permissions and access levels
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Groups (comma-separated)
              </label>
              <input
                type="text"
                value={(user.groups || []).join(', ')}
                onChange={e => handleGroupsChange(e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                placeholder="admin, users, editors"
              />
              <p className="mt-1 text-xs text-gray-500">
                Enter group names separated by commas. Users inherit permissions from all assigned
                groups.
              </p>

              {user.groups && user.groups.length > 0 && (
                <div className="mt-3">
                  <p className="text-sm font-medium text-gray-700 mb-2">Current Groups:</p>
                  <div className="flex flex-wrap gap-2">
                    {user.groups.map((group, index) => (
                      <span
                        key={index}
                        className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                      >
                        <Icon name="users" size="xs" className="mr-1" />
                        {group}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserFormEditor;
