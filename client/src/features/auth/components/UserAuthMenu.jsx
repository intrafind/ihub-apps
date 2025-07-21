import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import LoginForm from './LoginForm';
import Icon from '../../../shared/components/Icon';
import { Link } from 'react-router-dom';

const UserAuthMenu = () => {
  const { user, isAuthenticated, logout } = useAuth();
  const { platformConfig } = usePlatformConfig();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showAllGroups, setShowAllGroups] = useState(false);
  const dropdownRef = useRef(null);

  const auth = platformConfig?.auth || {};
  const authMode = auth.mode || 'anonymous';
  const allowAnonymous = platformConfig?.anonymousAuth?.enabled !== false;

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
    <div className="relative" ref={dropdownRef}>
      {/* User menu button */}
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="flex items-center space-x-2 text-white hover:text-white/80 focus:outline-none"
      >
        {isAuthenticated ? (
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
            <Icon name="user" size="md" className="text-white" />
            <span className="hidden md:block text-sm">Login</span>
          </>
        )}
        <Icon name="chevron-down" size="sm" className="text-white" />
      </button>

      {/* Dropdown menu */}
      {showDropdown && (
        <div className="absolute right-0 mt-2 w-64 bg-white rounded-md shadow-lg py-1 z-50 border border-gray-200">
          {isAuthenticated ? (
            <>
              {/* User info */}
              <div className="px-4 py-3 border-b border-gray-200">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-gray-300 rounded-full flex items-center justify-center">
                    <Icon name="user" size="md" className="text-gray-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {user?.name || user?.username || 'User'}
                    </p>
                    {user?.email && <p className="text-sm text-gray-500 truncate">{user.email}</p>}
                    {user?.groups && user.groups.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(showAllGroups ? user.groups : user.groups.slice(0, 3)).map(
                          (group, index) => (
                            <span
                              key={index}
                              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800"
                            >
                              {group}
                            </span>
                          )
                        )}
                        {user.groups.length > 3 && (
                          <button
                            onClick={e => {
                              e.preventDefault();
                              setShowAllGroups(!showAllGroups);
                            }}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                          >
                            {showAllGroups ? 'Show less' : `+${user.groups.length - 3} more`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Menu items */}
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
                  Admin Panel
                </Link>
              )}

              <button
                onClick={handleLogout}
                className="flex items-center w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                <Icon name="logout" size="sm" className="mr-3 text-gray-400" />
                Sign Out
              </button>
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
                Sign In
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
                <h3 className="text-lg font-medium text-gray-900">Sign In</h3>
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
