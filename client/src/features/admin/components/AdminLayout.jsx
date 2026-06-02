import { Outlet, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminKeyboardShortcuts } from '../hooks/useAdminKeyboardShortcuts';
import { Bars3Icon } from '@heroicons/react/24/outline';
import { useAdminAuth } from '../hooks/useAdminAuth';
import { useAuth } from '../../../shared/contexts/AuthContext';
import Icon from '../../../shared/components/Icon';
import { buildPath } from '../../../utils/runtimeBasePath';
import AdminSidebar from './AdminSidebar';
import AdminCommandPalette from './AdminCommandPalette';
import AdminShortcutsModal from './AdminShortcutsModal';
import { SidebarProvider, useSidebar } from '../contexts/SidebarContext';
import { getAdminNavSections } from './AdminSidebarNavData';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

function MobileTopbar() {
  const { t } = useTranslation();
  const { openMobile } = useSidebar();

  return (
    <div className="flex items-center h-12 px-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0 md:hidden">
      <button
        type="button"
        onClick={openMobile}
        aria-label={t('admin.sidebar.openMenu', 'Open menu')}
        className="p-1.5 -ml-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <Bars3Icon className="w-5 h-5" aria-hidden="true" />
      </button>
      <span className="ml-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('admin.sidebar.adminPanel', 'Admin Panel')}
      </span>
    </div>
  );
}

function AdminLayoutInner() {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const featureFlags = useFeatureFlags();
  const location = useLocation();
  const mainRef = useRef(null);
  const { showCheatsheet, setShowCheatsheet } = useAdminKeyboardShortcuts();

  const adminPages = platformConfig?.admin?.pages || {};
  const showAdminPage = key => adminPages[key] !== false;
  const sections = getAdminNavSections({ t, showAdminPage, featureFlags });

  // Note: content-admin filtering is handled in AdminSidebar;
  // we just need to provide all section IDs to SidebarProvider
  const sectionIds = sections.map(s => s.id);

  // Scroll main content to top on route change
  useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTop = 0;
    }
  }, [location.pathname]);

  return (
    <SidebarProvider sectionIds={sectionIds}>
      {/* Skip to admin content */}
      <a
        href="#admin-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-3 focus:py-2 focus:bg-white dark:focus:bg-gray-800 focus:text-indigo-600 focus:rounded focus:shadow-lg focus:text-sm focus:font-medium"
      >
        {t('admin.skipToContent', 'Skip to content')}
      </a>

      <MobileTopbar />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <AdminSidebar />

        <main
          ref={mainRef}
          id="admin-main-content"
          className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950 focus:outline-none"
          tabIndex={-1}
        >
          <Outlet />
        </main>
      </div>

      <AdminCommandPalette />
      <AdminShortcutsModal isOpen={showCheatsheet} onClose={() => setShowCheatsheet(false)} />
    </SidebarProvider>
  );
}

export default function AdminLayout() {
  const { t } = useTranslation();
  const { isAuthenticated, authRequired, isLoading } = useAdminAuth();
  const { isAuthenticated: userIsAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center flex-1 bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-400">
            {t('admin.checkingAuth', 'Checking authentication...')}
          </p>
        </div>
      </div>
    );
  }

  if (authRequired && !isAuthenticated) {
    return (
      <div className="flex items-center justify-center flex-1 bg-gray-50 dark:bg-gray-900">
        <div className="max-w-md w-full space-y-8 px-4">
          <div>
            <div className="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
              <Icon name="shield-exclamation" className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-gray-100">
              {t('admin.accessRequired', 'Admin Access Required')}
            </h2>
            <div className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
              <p>
                {t(
                  'admin.accessRequiredDesc',
                  'Admin access requires authentication with admin privileges.'
                )}
              </p>
              {userIsAuthenticated ? (
                <p className="mt-1 text-red-600 dark:text-red-400">
                  {t(
                    'admin.noAdminAccess',
                    'Your account does not have admin access. Contact your administrator.'
                  )}
                </p>
              ) : (
                <p className="mt-1 text-blue-600 dark:text-blue-400">
                  {t(
                    'admin.pleaseLogin',
                    'Please log in with an admin account to access the admin panel.'
                  )}
                </p>
              )}
            </div>
          </div>
          {!userIsAuthenticated && (
            <div className="mt-6 text-center">
              <a
                href={buildPath('/')}
                className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 font-medium"
              >
                {t('admin.returnToLogin', '← Return to login')}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <AdminLayoutInner />
    </div>
  );
}
