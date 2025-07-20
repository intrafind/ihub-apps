import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../../shared/contexts/AuthContext.jsx';
import Icon from '../../../shared/components/Icon.jsx';

const UserMenu = ({ className = '' }) => {
  const { user, isAuthenticated, logout, authConfig } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    setIsOpen(false);
    await logout();
  };

  // Don't render if user is not authenticated or if auth is not configured
  if (!isAuthenticated || !user || user.id === 'anonymous') {
    return null;
  }

  // Get user display name
  const displayName = user.name || user.email || user.id;
  const initials = displayName
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className={`relative ${className}`} ref={menuRef}>
      {/* User Avatar Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-2 p-2 rounded-lg hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-medium">
          {initials}
        </div>
        <div className="hidden sm:block text-left">
          <div className="text-sm font-medium text-gray-900">{displayName}</div>
          {user.email && user.email !== displayName && (
            <div className="text-xs text-gray-500">{user.email}</div>
          )}
        </div>
        <Icon name={isOpen ? 'chevron-up' : 'chevron-down'} className="w-4 h-4 text-gray-500" />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          {/* User Info */}
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="text-sm font-medium text-gray-900">{displayName}</div>
            {user.email && <div className="text-sm text-gray-500">{user.email}</div>}
            <div className="flex flex-wrap gap-1 mt-2">
              {user.groups?.map(group => (
                <span
                  key={group}
                  className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                >
                  {group}
                </span>
              ))}
            </div>
            {user.authMethod && (
              <div className="text-xs text-gray-400 mt-1">via {user.authMethod}</div>
            )}
          </div>

          {/* Menu Items */}
          <div className="py-1">
            {/* Profile/Settings (placeholder) */}
            <button
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
              onClick={() => setIsOpen(false)}
            >
              <Icon name="user" className="w-4 h-4 mr-3" />
              Profile
            </button>

            {/* Admin Panel (if admin) */}
            {user.isAdmin && (
              <a
                href="/admin"
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
                onClick={() => setIsOpen(false)}
              >
                <Icon name="settings" className="w-4 h-4 mr-3" />
                Admin Panel
              </a>
            )}

            {/* Logout */}
            <button
              onClick={handleLogout}
              className="w-full text-left px-4 py-2 text-sm text-red-700 hover:bg-red-50 flex items-center"
            >
              <Icon name="log-out" className="w-4 h-4 mr-3" />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserMenu;
