import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
  ArrowLeftIcon
} from '@heroicons/react/24/outline';
import { useSidebar } from '../contexts/SidebarContext';
import { getAdminNavSections } from './AdminSidebarNavData';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useAuth } from '../../../shared/contexts/AuthContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

// Sections visible to content-admin-only users
const CONTENT_ADMIN_SECTIONS = new Set(['overview', 'aiWorkspace']);
// Items within aiWorkspace visible to content-admin-only users
const CONTENT_ADMIN_ITEMS = new Set(['apps', 'prompts', 'sources']);

function NavItem({ item, isCollapsed }) {
  const location = useLocation();
  const isActive =
    item.href === '/admin'
      ? location.pathname === '/admin'
      : location.pathname.startsWith(item.href);

  const Icon = item.icon;

  if (isCollapsed) {
    return (
      <div className="relative group">
        <Link
          to={item.href}
          aria-current={isActive ? 'page' : undefined}
          className={`flex items-center justify-center h-9 w-9 mx-auto rounded-md transition-colors ${
            isActive
              ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
          }`}
        >
          <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
        </Link>
        {/* Flyout tooltip */}
        <div
          className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-gray-900 dark:bg-gray-700 text-white text-xs whitespace-nowrap z-50 opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity"
          role="tooltip"
        >
          {item.label}
        </div>
      </div>
    );
  }

  return (
    <Link
      to={item.href}
      aria-current={isActive ? 'page' : undefined}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors border-l-2 ${
        isActive
          ? 'border-indigo-600 dark:border-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium'
          : 'border-transparent text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
      }`}
    >
      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}

function SectionHeader({ section, isCollapsed, isExpanded, onToggle, hasActiveChild }) {
  const Icon = section.icon;

  if (isCollapsed) {
    return (
      <div className="relative group py-1">
        <div
          className={`flex items-center justify-center h-9 w-9 mx-auto rounded-md ${
            hasActiveChild
              ? 'text-indigo-600 dark:text-indigo-400'
              : 'text-gray-500 dark:text-gray-400'
          }`}
          aria-hidden="true"
        >
          <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
        </div>
        <div
          className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-gray-900 dark:bg-gray-700 text-white text-xs whitespace-nowrap z-50 opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity"
          role="tooltip"
        >
          {section.label}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className="flex items-center w-full px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors gap-1.5"
    >
      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">{section.label}</span>
      {isExpanded ? (
        <ChevronDownIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRightIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

function SidebarContent({ sections }) {
  const location = useLocation();
  const { isCollapsed, expandedSections, toggleSection, expandSection } = useSidebar();

  // Auto-expand section containing active route
  useEffect(() => {
    for (const section of sections) {
      if (
        section.items.some(item =>
          item.href === '/admin'
            ? location.pathname === '/admin'
            : location.pathname.startsWith(item.href)
        )
      ) {
        expandSection(section.id);
        break;
      }
    }
  }, [location.pathname, sections, expandSection]);

  return (
    <div className="flex-1 overflow-y-auto py-2 space-y-1 scrollbar-thin">
      {sections.map(section => {
        if (section.items.length === 0) return null;

        const isExpanded = expandedSections.has(section.id);
        const hasActiveChild = section.items.some(item =>
          item.href === '/admin'
            ? location.pathname === '/admin'
            : location.pathname.startsWith(item.href)
        );

        // Single-item sections (like Overview and Integrations): render item directly without collapse header
        if (section.items.length === 1 && !isCollapsed) {
          return (
            <div key={section.id} className="px-2">
              <NavItem item={section.items[0]} isCollapsed={false} />
            </div>
          );
        }

        return (
          <div key={section.id} className={isCollapsed ? 'px-2 py-1' : 'px-2'}>
            {!isCollapsed && (
              <SectionHeader
                section={section}
                isCollapsed={isCollapsed}
                isExpanded={isExpanded}
                hasActiveChild={hasActiveChild}
                onToggle={() => toggleSection(section.id)}
              />
            )}
            {isCollapsed ? (
              <div className="space-y-1">
                {section.items.map(item => (
                  <NavItem key={item.key} item={item} isCollapsed={true} />
                ))}
              </div>
            ) : (
              isExpanded && (
                <div className="space-y-0.5 mt-0.5 ml-2">
                  {section.items.map(item => (
                    <NavItem key={item.key} item={item} isCollapsed={false} />
                  ))}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function AdminSidebar({ onMobileToggle }) {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const { user } = useAuth();
  const featureFlags = useFeatureFlags();
  const { isCollapsed, isMobileOpen, toggle, closeMobile } = useSidebar();
  const drawerRef = useRef(null);

  const adminPages = platformConfig?.admin?.pages || {};
  const showAdminPage = key => adminPages[key] !== false;

  // Check if user is content-admin-only (has contentAdmin but not full adminAccess)
  const isContentAdminOnly =
    user?.permissions?.contentAdmin && !user?.permissions?.adminAccess && !user?.isAdmin;

  let sections = getAdminNavSections({ t, showAdminPage, featureFlags });

  // Filter sections for content-admin-only users
  if (isContentAdminOnly) {
    sections = sections
      .filter(s => CONTENT_ADMIN_SECTIONS.has(s.id))
      .map(s => {
        if (s.id === 'aiWorkspace') {
          return { ...s, items: s.items.filter(item => CONTENT_ADMIN_ITEMS.has(item.key)) };
        }
        return s;
      });
  }

  // Trap focus in mobile drawer and close on Escape
  useEffect(() => {
    if (!isMobileOpen) return;

    const handleKeyDown = e => {
      if (e.key === 'Escape') {
        closeMobile();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMobileOpen, closeMobile]);

  const sidebarBody = (
    <>
      {/* Back to the main app */}
      <div className={`${isCollapsed ? 'px-2' : 'px-3'} pt-3 pb-2`}>
        {isCollapsed ? (
          <div className="relative group">
            <Link
              to="/"
              aria-label={t('admin.sidebar.backToApp', 'Back to iHub')}
              className="flex items-center justify-center h-9 w-9 mx-auto rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              <ArrowLeftIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
            </Link>
            <div
              className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-gray-900 dark:bg-gray-700 text-white text-xs whitespace-nowrap z-50 opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity"
              role="tooltip"
            >
              {t('admin.sidebar.backToApp', 'Back to iHub')}
            </div>
          </div>
        ) : (
          <Link
            to="/"
            className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <ArrowLeftIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{t('admin.sidebar.backToApp', 'Back to iHub')}</span>
          </Link>
        )}
      </div>

      {/* Search stub */}
      {!isCollapsed && (
        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('admin:open-palette'))}
            className="flex items-center w-full gap-2 px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            aria-label={t('admin.sidebar.search', 'Search admin...')}
          >
            <MagnifyingGlassIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left text-xs">
              {t('admin.sidebar.searchPlaceholder', 'Search admin... Cmd+K')}
            </span>
          </button>
        </div>
      )}

      <SidebarContent sections={sections} />

      {/* Collapse toggle */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={
            isCollapsed
              ? t('admin.sidebar.expand', 'Expand sidebar')
              : t('admin.sidebar.collapse', 'Collapse sidebar')
          }
          className="flex items-center justify-center w-full h-9 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        >
          {isCollapsed ? (
            <ChevronDoubleRightIcon className="w-5 h-5" aria-hidden="true" />
          ) : (
            <ChevronDoubleLeftIcon className="w-5 h-5" aria-hidden="true" />
          )}
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden md:flex flex-col h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 transition-all duration-200 shrink-0 ${
          isCollapsed ? 'w-16' : 'w-64'
        }`}
      >
        <nav
          aria-label={t('admin.sidebar.navLabel', 'Admin navigation')}
          className="flex flex-col h-full"
        >
          {sidebarBody}
        </nav>
      </aside>

      {/* Mobile: backdrop + off-canvas drawer */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          aria-hidden="true"
          onClick={closeMobile}
        />
      )}
      <aside
        ref={drawerRef}
        className={`fixed inset-y-0 left-0 z-40 flex flex-col w-72 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 transform transition-transform duration-200 md:hidden ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label={t('admin.sidebar.navLabel', 'Admin navigation')}
      >
        {/* Mobile drawer header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.sidebar.adminPanel', 'Admin Panel')}
          </span>
          <button
            type="button"
            onClick={closeMobile}
            aria-label={t('admin.sidebar.closeMenu', 'Close menu')}
            className="p-1 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <XMarkIcon className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <nav className="flex flex-col flex-1 overflow-hidden">
          {/* Back to the main app */}
          <div className="px-3 pt-3 pb-1">
            <Link
              to="/"
              onClick={closeMobile}
              className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              <ArrowLeftIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t('admin.sidebar.backToApp', 'Back to iHub')}</span>
            </Link>
          </div>
          {/* Search stub (always expanded in mobile) */}
          <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('admin:open-palette'))}
              className="flex items-center w-full gap-2 px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-md"
              aria-label={t('admin.sidebar.search', 'Search admin...')}
            >
              <MagnifyingGlassIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="text-xs">
                {t('admin.sidebar.searchPlaceholder', 'Search admin... Cmd+K')}
              </span>
            </button>
          </div>
          <SidebarContent sections={sections} />
        </nav>
      </aside>
    </>
  );
}
