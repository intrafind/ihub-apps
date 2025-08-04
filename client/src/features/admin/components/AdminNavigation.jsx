import { useState, useRef, useEffect, useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

const AdminNavigation = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { platformConfig } = usePlatformConfig();
  const pageConfig = platformConfig?.admin?.pages || {};
  const isEnabled = key => pageConfig[key] !== false;

  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const desktopMoreMenuRef = useRef(null);
  const mobileMoreMenuRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      const isClickInsideDesktop =
        desktopMoreMenuRef.current && desktopMoreMenuRef.current.contains(event.target);
      const isClickInsideMobile =
        mobileMoreMenuRef.current && mobileMoreMenuRef.current.contains(event.target);

      if (!isClickInsideDesktop && !isClickInsideMobile) {
        setShowMoreMenu(false);
      }
    };

    if (showMoreMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMoreMenu]);

  // Define logical groups for admin navigation
  const navGroups = [
    {
      id: 'overview',
      name: t('admin.groups.overview', 'Overview'),
      items: [
        {
          key: 'home',
          name: t('admin.nav.home', 'Home'),
          href: '/admin',
          // icon: 'home',
          current: location.pathname === '/admin'
        }
      ]
    },
    {
      id: 'content',
      name: t('admin.groups.content', 'Content Management'),
      items: [
        {
          key: 'apps',
          name: t('admin.nav.apps', 'Apps'),
          href: '/admin/apps',
          // icon: 'collection',
          current: location.pathname.startsWith('/admin/apps')
        },
        {
          key: 'models',
          name: t('admin.nav.models', 'Models'),
          href: '/admin/models',
          // icon: 'cpu-chip',
          current: location.pathname.startsWith('/admin/models')
        },
        {
          key: 'prompts',
          name: t('admin.nav.prompts', 'Prompts'),
          href: '/admin/prompts',
          // icon: 'clipboard-document-list',
          current: location.pathname.startsWith('/admin/prompts')
        },
        {
          key: 'pages',
          name: t('admin.nav.pages', 'Pages'),
          href: '/admin/pages',
          // icon: 'document',
          current: location.pathname.startsWith('/admin/pages')
        },
        {
          key: 'shortlinks',
          name: t('admin.nav.shortlinks', 'Short Links'),
          href: '/admin/shortlinks',
          // icon: 'link',
          current: location.pathname.startsWith('/admin/shortlinks')
        }
      ]
    },
    {
      id: 'analytics',
      name: t('admin.groups.analytics', 'Analytics'),
      items: [
        {
          key: 'usage',
          name: t('admin.nav.usage', 'Usage Reports'),
          href: '/admin/usage',
          // icon: 'chart-bar',
          current: location.pathname === '/admin/usage'
        }
      ]
    },
    {
      id: 'security',
      name: t('admin.groups.security', 'Security & Access'),
      items: [
        {
          key: 'auth',
          name: t('admin.nav.auth', 'Authentication'),
          href: '/admin/auth',
          // icon: 'shield-check',
          current: location.pathname === '/admin/auth'
        },
        // Only show Users navigation if authentication is enabled
        ...(platformConfig?.localAuth?.enabled ||
        platformConfig?.oidcAuth?.enabled ||
        platformConfig?.proxyAuth?.enabled
          ? [
              {
                key: 'users',
                name: t('admin.nav.users', 'Users'),
                href: '/admin/users',
                // icon: 'user',
                current: location.pathname.startsWith('/admin/users')
              }
            ]
          : []),
        // Only show Groups navigation if authentication is enabled
        ...(platformConfig?.localAuth?.enabled ||
        platformConfig?.oidcAuth?.enabled ||
        platformConfig?.proxyAuth?.enabled
          ? [
              {
                key: 'groups',
                name: t('admin.nav.groups', 'Groups'),
                href: '/admin/groups',
                // icon: 'users',
                current: location.pathname.startsWith('/admin/groups')
              }
            ]
          : [])
      ]
    },
    {
      id: 'configuration',
      name: t('admin.groups.configuration', 'Configuration'),
      items: [
        {
          key: 'ui',
          name: t('admin.nav.ui', 'UI'),
          href: '/admin/ui',
          // icon: 'cog',
          current: location.pathname === '/admin/ui'
        },
        {
          key: 'system',
          name: t('admin.nav.system', 'System'),
          href: '/admin/system',
          // icon: 'cog',
          current: location.pathname === '/admin/system'
        }
      ]
    }
  ];

  // Memoize navigation calculations to prevent unnecessary re-renders
  const { desktopVisibleItems, desktopHiddenItems, mobileVisibleItems, mobileHiddenItems } =
    useMemo(() => {
      // Flatten nav items for compatibility with existing overflow logic
      const navItems = navGroups.flatMap(group => group.items);

      // Filter enabled items
      const enabledItems = navItems.filter(item => isEnabled(item.key));

      // Fixed desktop items: home, apps, models, prompts, pages, shortlinks
      const desktopVisibleKeys = ['home', 'apps', 'models', 'prompts', 'pages', 'shortlinks'];

      // Desktop: show specific items, rest go to more menu
      const desktopVisibleItems = enabledItems.filter(item =>
        desktopVisibleKeys.includes(item.key)
      );
      const desktopHiddenItems = enabledItems.filter(
        item => !desktopVisibleKeys.includes(item.key)
      );

      // Mobile: use first 3 enabled items
      const mobileVisibleItems = enabledItems.slice(0, 3);
      const mobileHiddenItems = enabledItems.slice(3);

      return {
        desktopVisibleItems,
        desktopHiddenItems,
        mobileVisibleItems,
        mobileHiddenItems
      };
    }, [navGroups, isEnabled]);

  const TabItem = ({ item, isDropdownItem = false }) => (
    <Link
      to={item.href}
      className={
        isDropdownItem
          ? `flex items-center w-full px-4 py-2 text-sm hover:bg-gray-100 ${
              item.current ? 'bg-indigo-50 text-indigo-600 font-medium' : 'text-gray-700'
            }`
          : `inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium ${
              item.current
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`
      }
      onClick={() => isDropdownItem && setShowMoreMenu(false)}
    >
      <Icon name={item.icon} className="w-4 h-4 mr-2" />
      {item.name}
    </Link>
  );

  const GroupHeader = ({ groupName }) => (
    <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-200">
      {groupName}
    </div>
  );

  // Helper function to get groups with items that should be in dropdown
  const getGroupedDropdownItems = () => {
    const result = [];

    navGroups.forEach(group => {
      const groupItems = group.items.filter(
        item => isEnabled(item.key) && hiddenItems.some(hiddenItem => hiddenItem.key === item.key)
      );

      if (groupItems.length > 0) {
        result.push({
          type: 'group',
          group: group,
          items: groupItems
        });
      }
    });

    return result;
  };

  return (
    <nav className="bg-white shadow-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-center">
          <div className="flex items-center space-x-8">
            {/* Desktop layout - always show specific items */}
            <div className="hidden md:flex items-center space-x-8">
              {desktopVisibleItems.map(item => (
                <TabItem key={item.name} item={item} />
              ))}

              {/* Desktop More button */}
              {desktopHiddenItems.length > 0 && (
                <div className="relative inline-block" ref={desktopMoreMenuRef}>
                  <button
                    onClick={() => setShowMoreMenu(prev => !prev)}
                    className={`
                      inline-flex items-center px-1 pt-2 border-b-2 border-transparent text-sm font-medium
                      ${
                        desktopHiddenItems.some(item => item.current)
                          ? 'text-indigo-600'
                          : 'text-gray-500 hover:text-gray-700'
                      }
                    `}
                    aria-expanded={showMoreMenu}
                    aria-haspopup="true"
                  >
                    <Icon name="menu" className="w-4 h-4 mr-2" />
                    {t('admin.nav.more', 'More')}
                    <Icon
                      name="chevron-down"
                      className={`w-4 h-4 ml-1 transition-transform duration-200 ${showMoreMenu ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {/* Desktop dropdown menu */}
                  {showMoreMenu && (
                    <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                      {navGroups.map((group, groupIndex) => {
                        const groupItems = group.items.filter(
                          item =>
                            isEnabled(item.key) &&
                            desktopHiddenItems.some(hiddenItem => hiddenItem.key === item.key)
                        );

                        if (groupItems.length === 0) return null;

                        return (
                          <div key={group.id}>
                            {groupIndex > 0 && <div className="border-t border-gray-200 my-1" />}
                            <GroupHeader groupName={group.name} />
                            {groupItems.map(item => (
                              <TabItem key={item.key} item={item} isDropdownItem />
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Mobile layout - show first 3 items */}
            <div className="flex md:hidden items-center space-x-8">
              {mobileVisibleItems.map(item => (
                <TabItem key={item.name} item={item} />
              ))}

              {/* Mobile More button */}
              {mobileHiddenItems.length > 0 && (
                <div className="relative inline-block" ref={mobileMoreMenuRef}>
                  <button
                    onClick={() => setShowMoreMenu(prev => !prev)}
                    className={`
                      inline-flex items-center px-1 pt-2 border-b-2 border-transparent text-sm font-medium
                      ${
                        mobileHiddenItems.some(item => item.current)
                          ? 'text-indigo-600'
                          : 'text-gray-500 hover:text-gray-700'
                      }
                    `}
                    aria-expanded={showMoreMenu}
                    aria-haspopup="true"
                  >
                    <Icon name="menu" className="w-4 h-4 mr-2" />
                    {t('admin.nav.more', 'More')}
                    <Icon
                      name="chevron-down"
                      className={`w-4 h-4 ml-1 transition-transform duration-200 ${showMoreMenu ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {/* Mobile dropdown menu */}
                  {showMoreMenu && (
                    <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                      {navGroups.map((group, groupIndex) => {
                        const groupItems = group.items.filter(
                          item =>
                            isEnabled(item.key) &&
                            mobileHiddenItems.some(hiddenItem => hiddenItem.key === item.key)
                        );

                        if (groupItems.length === 0) return null;

                        return (
                          <div key={group.id}>
                            {groupIndex > 0 && <div className="border-t border-gray-200 my-1" />}
                            <GroupHeader groupName={group.name} />
                            {groupItems.map(item => (
                              <TabItem key={item.key} item={item} isDropdownItem />
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default AdminNavigation;
