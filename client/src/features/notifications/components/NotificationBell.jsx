import { useEffect, useRef, useState } from 'react';
import { BellIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import useNotifications from '../hooks/useNotifications';
import NotificationPanel from './NotificationPanel';

/**
 * Header bell + unread badge + dropdown panel. Only mounted when the
 * 'notifications' feature flag is enabled and the user is authenticated.
 */
export default function NotificationBell() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications({
    enabled: true
  });

  useEffect(() => {
    if (!open) return undefined;

    const handleClickOutside = event => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleEscape = event => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="relative text-white/90 hover:text-white p-1"
        onClick={() => setOpen(prev => !prev)}
        aria-label={t('notifications.toggle', 'Notifications')}
        aria-expanded={open}
      >
        <BellIcon className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] leading-none rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <NotificationPanel
          notifications={notifications}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
        />
      )}
    </div>
  );
}
