import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useFeatureFlags } from '../../../shared/hooks/useFeatureFlags';
import { useKeyboardNavigation } from '../../../shared/hooks/useKeyboardNavigation';
import Icon from '../../../shared/components/Icon';
import { Link } from 'react-router-dom';

/**
 * UserAuthMenu component - A unified user authentication menu that supports multiple variants
 * @param {Object} props - Component props
 * @param {'header' | 'sidebar'} props.variant - The visual variant of the menu (default: 'header')
 * @param {string} props.className - Additional CSS classes to apply to the root element
 * @returns {JSX.Element|null} The user authentication menu component
 */
export default function UserAuthMenu({ variant = 'header', className = '', collapsed = false }) {
  const { t } = useTranslation();
  const { user, isAuthenticated, logout, authConfig } = useAuth();
  const { platformConfig } = usePlatformConfig();
  const featureFlags = useFeatureFlags();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showAllGroups, setShowAllGroups] = useState(false);
  const dropdownRef = useRef(null);
  const menuRef = useRef(null);

  /** Handles selecting a menu item via keyboard (Enter/Space) */
  const handleMenuSelect = useCallback(index => {
    const items = menuRef.current?.querySelectorAll('[role="menuitem"]');
    items?.[index]?.click();
  }, []);

  /** Handles closing the dropdown via Escape key */
  const handleMenuClose = useCallback(() => {
    setShowDropdown(false);
    setShowAllGroups(false);
  }, []);

  useKeyboardNavigation(menuRef, {
    isActive: showDropdown,
    onSelect: handleMenuSelect,
    onClose: handleMenuClose
  });

  const auth = platformConfig?.auth || {};
  const authMode = authConfig?.authMode || auth.mode || 'anonymous';
  const allowAnonymous =
    authConfig?.anonymousAuth?.enabled ?? platformConfig?.anonymousAuth?.enabled !== false;

  // Calculate user initials for sidebar variant
  const displayName = user?.name || user?.email || user?.username || user?.id || 'User';
  const initials = displayName
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
        setShowAllGroups(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Don't show anything in proxy mode - authentication is handled externally
  if (authMode === 'proxy') {
    return null;
  }

  // Check if any authentication methods are actually enabled
  const hasEnabledAuthMethods =
    authConfig?.authMethods?.local?.enabled ||
    authConfig?.authMethods?.oidc?.enabled ||
    authConfig?.authMethods?.proxy?.enabled ||
    authConfig?.authMethods?.ldap?.enabled ||
    authConfig?.authMethods?.ntlm?.enabled;

  // Don't show login options when in anonymous-only mode
  // This happens when anonymousAuth is enabled and no auth methods are enabled
  if (allowAnonymous && !hasEnabledAuthMethods) {
    return null;
  }

  // For sidebar variant, don't render if user is not authenticated or is anonymous
  if (variant === 'sidebar' && (!isAuthenticated || !user || user.id === 'anonymous')) {
    return null;
  }

  const handleLoginClick = () => {
    setShowDropdown(false);
    setShowAllGroups(false);
    // The auth gate is the single login dialog for the whole app (it handles
    // every auth method). Open it as a dismissible overlay when anonymous
    // access is allowed; otherwise open the non-dismissible full-page gate so
    // closing it can't reveal an app the user isn't permitted to use.
    if (window.__authGate) {
      window.__authGate.show({ overlay: allowAnonymous });
    } else {
      // The gate is inlined on every index.html entry, so this should not
      // happen where UserAuthMenu renders. Warn instead of failing silently.
      console.warn('Auth gate is unavailable; cannot open the login dialog.');
    }
  };

  const handleLogout = () => {
    logout();
    setShowDropdown(false);
    setShowAllGroups(false);
  };

  // Use the backend-calculated isAdmin flag instead of hardcoded group names
  const isAdmin = user?.isAdmin === true;

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {/* User menu button */}
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className={
          variant === 'header'
            ? 'flex items-center space-x-2 text-white hover:text-white/80 focus:outline-none'
            : 'flex items-center space-x-2 p-2 rounded-lg hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors'
        }
        aria-expanded={showDropdown}
        aria-haspopup="true"
      >
        {isAuthenticated ? (
          <>
            {variant === 'header' ? (
              <>
                <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
                  <Icon name="user" size="sm" className="text-white" />
                </div>
                <span className="hidden md:block text-sm">
                  {user?.name || user?.username || 'User'}
                </span>
              </>
            ) : (
              <>
                <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-medium flex-none">
                  {initials}
                </div>
                {!collapsed && (
                  <div className="hidden sm:block text-left min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {displayName}
                    </div>
                    {user?.email && user.email !== displayName && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {user.email}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <Icon
              name="user"
              size="md"
              className={variant === 'header' ? 'text-white' : 'text-gray-600'}
            />
            <span
              className={variant === 'header' ? 'hidden md:block text-sm' : 'text-sm text-gray-600'}
            >
              Login
            </span>
          </>
        )}
        {!collapsed && (
          <Icon
            name="chevron-down"
            size="sm"
            className={`transition-transform duration-200 ${showDropdown ? 'rotate-180' : ''} ${variant === 'header' ? 'text-white' : 'text-gray-500'}`}
          />
        )}
      </button>

      {/* Dropdown menu */}
      {showDropdown && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('auth.userMenu', 'User menu')}
          className={
            variant === 'sidebar'
              ? // In the sidebar the trigger sits at the very bottom, so the menu
                // floats upward instead of pushing the layout (which would happen
                // if it opened downward off-screen). When the rail is collapsed it
                // gets a fixed width and floats over the content to the right.
                `absolute bottom-full mb-2 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 z-50 ${
                  collapsed ? 'left-0 w-64' : 'left-0 right-0'
                }`
              : 'absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50'
          }
        >
          {isAuthenticated ? (
            <>
              {/* User info */}
              <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {displayName}
                </div>
                {user?.email && (
                  <div className="text-sm text-gray-500 dark:text-gray-400">{user.email}</div>
                )}
                {user?.groups && user.groups.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(showAllGroups ? user.groups : user.groups.slice(0, 3)).map((group, index) => (
                      <span
                        key={index}
                        className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200"
                      >
                        {group}
                      </span>
                    ))}
                    {user.groups.length > 3 && (
                      <button
                        onClick={e => {
                          e.preventDefault();
                          setShowAllGroups(!showAllGroups);
                        }}
                        className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                      >
                        {showAllGroups ? 'Show less' : `+${user.groups.length - 3} more`}
                      </button>
                    )}
                  </div>
                )}
                {user?.authMethod && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    via {user.authMethod}
                  </div>
                )}
              </div>

              {/* Menu items */}
              <div className="py-1">
                {/* Integrations */}
                {featureFlags.isEnabled('integrations', true) &&
                  (platformConfig?.cloudStorage?.enabled || platformConfig?.jira?.enabled) && (
                    <Link
                      to="/settings/integrations"
                      role="menuitem"
                      tabIndex={-1}
                      className="flex items-center px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => {
                        setShowDropdown(false);
                        setShowAllGroups(false);
                      }}
                    >
                      <Icon
                        name="link"
                        size="sm"
                        className="mr-3 text-gray-400 dark:text-gray-500"
                      />
                      {t('auth.menu.integrations', 'Integrations')}
                    </Link>
                  )}

                {/* Admin Panel */}
                {isAdmin && (
                  <Link
                    to="/admin"
                    role="menuitem"
                    tabIndex={-1}
                    className="flex items-center px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => {
                      setShowDropdown(false);
                      setShowAllGroups(false);
                    }}
                  >
                    <Icon
                      name="settings"
                      size="sm"
                      className="mr-3 text-gray-400 dark:text-gray-500"
                    />
                    {t('auth.menu.adminPanel', 'Admin Panel')}
                  </Link>
                )}

                {/* Logout */}
                <button
                  role="menuitem"
                  tabIndex={-1}
                  onClick={handleLogout}
                  className="flex items-center w-full px-4 py-2 text-sm text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
                >
                  <Icon
                    name={variant === 'sidebar' ? 'log-out' : 'logout'}
                    size="sm"
                    className="mr-3 text-red-400"
                  />
                  {t('auth.menu.signOut', 'Sign Out')}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Anonymous user */}
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center">
                    <Icon name="user" size="md" className="text-gray-600 dark:text-gray-300" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Anonymous User
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Not signed in</p>
                  </div>
                </div>
              </div>

              <button
                role="menuitem"
                tabIndex={-1}
                onClick={handleLoginClick}
                className="flex items-center w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Icon name="login" size="sm" className="mr-3 text-gray-400 dark:text-gray-500" />
                {t('auth.menu.signIn', 'Sign In')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
