import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import LoginForm from './LoginForm';
import Icon from '../../../shared/components/Icon';
import { Link } from 'react-router-dom';

/**
 * UserAuthMenu component - A unified user authentication menu that supports multiple variants
 * @param {Object} props - Component props
 * @param {'header' | 'sidebar'} props.variant - The visual variant of the menu (default: 'header')
 * @param {string} props.className - Additional CSS classes to apply to the root element
 * @returns {JSX.Element|null} The user authentication menu component
 */
const UserAuthMenu = ({ variant = 'header', className = '' }) => {
  const { t } = useTranslation();
  const { user, isAuthenticated, logout } = useAuth();
  const { platformConfig } = usePlatformConfig();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showAllGroups, setShowAllGroups] = useState(false);
  const dropdownRef = useRef(null);

  const auth = platformConfig?.auth || {};
  const authMode = auth.mode || 'anonymous';
  const allowAnonymous = platformConfig?.anonymousAuth?.enabled !== false;

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
    platformConfig?.localAuth?.enabled ||
    platformConfig?.oidcAuth?.enabled ||
    platformConfig?.proxyAuth?.enabled;

  // Don't show login options when in anonymous-only mode
  // This happens when anonymousAuth is enabled and no auth methods are enabled
  if (allowAnonymous && !hasEnabledAuthMethods) {
    return null;
  }

  // For sidebar variant, don't render if user is not authenticated or is anonymous
  if (variant === 'sidebar' && (!isAuthenticated || !user || user.id === 'anonymous')) {
    return null;
  }

  // If anonymous access is not allowed and user is not authenticated, show login modal
  if (!allowAnonymous && !isAuthenticated) {
    return createPortal(
      <div
        className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full"
        style={{ zIndex: 2147483647 }}
      >
        <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
          <LoginForm />
        </div>
      </div>,
      document.body
    );
  }

  const handleLoginClick = () => {
    setShowLoginModal(true);
    setShowDropdown(false);
    setShowAllGroups(false);
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
                <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-medium">
                  {initials}
                </div>
                <div className="hidden sm:block text-left">
                  <div className="text-sm font-medium text-gray-900">{displayName}</div>
                  {user?.email && user.email !== displayName && (
                    <div className="text-xs text-gray-500">{user.email}</div>
                  )}
                </div>
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
        <Icon
          name={showDropdown ? 'chevron-up' : 'chevron-down'}
          size="sm"
          className={variant === 'header' ? 'text-white' : 'text-gray-500'}
        />
      </button>

      {/* Dropdown menu */}
      {showDropdown && (
        <div className="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          {isAuthenticated ? (
            <>
              {/* User info */}
              <div className="px-4 py-3 border-b border-gray-100">
                <div className="text-sm font-medium text-gray-900">{displayName}</div>
                {user?.email && <div className="text-sm text-gray-500">{user.email}</div>}
                {user?.groups && user.groups.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(showAllGroups ? user.groups : user.groups.slice(0, 3)).map((group, index) => (
                      <span
                        key={index}
                        className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
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
                        className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                      >
                        {showAllGroups ? 'Show less' : `+${user.groups.length - 3} more`}
                      </button>
                    )}
                  </div>
                )}
                {user?.authMethod && (
                  <div className="text-xs text-gray-400 mt-1">via {user.authMethod}</div>
                )}
              </div>

              {/* Menu items */}
              <div className="py-1">
                {/* Profile (placeholder for sidebar variant) */}
                {variant === 'sidebar' && (
                  <button
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
                    onClick={() => {
                      setShowDropdown(false);
                      setShowAllGroups(false);
                    }}
                  >
                    <Icon name="user" className="w-4 h-4 mr-3" />
                    {t('auth.menu.profile', 'Profile')}
                  </button>
                )}

                {/* Admin Panel */}
                {isAdmin && (
                  <Link
                    to="/admin"
                    className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    onClick={() => {
                      setShowDropdown(false);
                      setShowAllGroups(false);
                    }}
                  >
                    <Icon name="settings" size="sm" className="mr-3 text-gray-400" />
                    {t('auth.menu.adminPanel', 'Admin Panel')}
                  </Link>
                )}

                {/* Logout */}
                <button
                  onClick={handleLogout}
                  className="flex items-center w-full px-4 py-2 text-sm text-red-700 hover:bg-red-50"
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
              <div className="px-4 py-3 border-b border-gray-200">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-gray-300 rounded-full flex items-center justify-center">
                    <Icon name="user" size="md" className="text-gray-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Anonymous User</p>
                    <p className="text-sm text-gray-500">Not signed in</p>
                  </div>
                </div>
              </div>

              <button
                onClick={handleLoginClick}
                className="flex items-center w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                <Icon name="login" size="sm" className="mr-3 text-gray-400" />
                {t('auth.menu.signIn', 'Sign In')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Login modal */}
      {showLoginModal &&
        createPortal(
          <div
            className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full"
            style={{ zIndex: 2147483647 }}
          >
            <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  {t('auth.menu.signIn', 'Sign In')}
                </h3>
                <button
                  onClick={() => setShowLoginModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <Icon name="x" size="md" />
                </button>
              </div>
              <LoginForm onSuccess={() => setShowLoginModal(false)} />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default UserAuthMenu;
