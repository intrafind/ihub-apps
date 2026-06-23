import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  WindowIcon,
  UsersIcon,
  ChatBubbleLeftRightIcon,
  TagIcon,
  ArrowTopRightOnSquareIcon,
  PlusIcon,
  CpuChipIcon,
  ChartBarIcon,
  ArrowRightIcon,
  ShieldCheckIcon,
  BoltIcon,
  CircleStackIcon,
  WrenchIcon,
  KeyIcon,
  ArrowUpCircleIcon
} from '@heroicons/react/24/outline';
import { useOverviewData } from '../hooks/useOverviewData';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

function StatCard({
  label,
  value,
  sub,
  href,
  icon: Icon,
  iconColor,
  updateAvailable,
  latestVersion
}) {
  const { t } = useTranslation();
  return (
    <Link
      to={href}
      className="block bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:border-indigo-300 dark:hover:border-indigo-600 hover:shadow-sm transition-all group"
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide truncate">
            {label}
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
            {value}
          </p>
          {sub && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{sub}</p>}
          {updateAvailable && latestVersion && (
            <p className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
              <ArrowUpCircleIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              {t('admin.overview.updateAvailable', 'v{{version}} available', {
                version: latestVersion
              })}
            </p>
          )}
        </div>
        <div className={`p-2.5 rounded-lg ${iconColor} shrink-0 ml-3`}>
          <Icon className="w-5 h-5" aria-hidden="true" />
        </div>
      </div>
      <div className="mt-3 flex items-center text-xs text-indigo-600 dark:text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity">
        <span>{t('admin.overview.viewDetails', 'View details')}</span>
        <ArrowRightIcon className="w-3 h-3 ml-1" aria-hidden="true" />
      </div>
    </Link>
  );
}

function SetupChecklist() {
  const { t } = useTranslation();

  const steps = [
    {
      id: 'install',
      label: t('admin.overview.setup.installed', 'Platform installed'),
      done: true,
      href: null
    },
    {
      id: 'admin',
      label: t('admin.overview.setup.adminAccount', 'Admin account ready'),
      done: true,
      href: null
    },
    {
      id: 'provider',
      label: t('admin.overview.setup.addProvider', 'Configure an LLM provider'),
      done: false,
      href: '/admin/providers'
    },
    {
      id: 'app',
      label: t('admin.overview.setup.createApp', 'Create your first app'),
      done: false,
      href: '/admin/apps'
    },
    {
      id: 'identity',
      label: t('admin.overview.setup.configureAuth', 'Connect identity provider (optional)'),
      done: false,
      href: '/admin/auth'
    },
    {
      id: 'features',
      label: t('admin.overview.setup.reviewFeatures', 'Review feature flags'),
      done: false,
      href: '/admin/features'
    }
  ];

  const completedCount = steps.filter(s => s.done).length;
  const progress = Math.round((completedCount / steps.length) * 100);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.overview.gettingStarted', 'Getting started')}
        </h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {completedCount}/{steps.length}
        </span>
      </div>
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 mb-4">
        <div
          className="bg-indigo-600 h-1.5 rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      <ul className="space-y-2.5">
        {steps.map(step => (
          <li key={step.id} className="flex items-center gap-3">
            <div
              className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                step.done
                  ? 'bg-indigo-600 border-indigo-600'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600'
              }`}
            >
              {step.done && (
                <svg
                  className="w-2.5 h-2.5 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={3}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
            {step.href && !step.done ? (
              <Link
                to={step.href}
                className="text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 flex items-center gap-1"
              >
                {step.label}
                <ArrowTopRightOnSquareIcon className="w-3 h-3" aria-hidden="true" />
              </Link>
            ) : (
              <span
                className={`text-sm ${step.done ? 'text-gray-500 dark:text-gray-400 line-through' : 'text-gray-700 dark:text-gray-300'}`}
              >
                {step.label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuickActions() {
  const { t } = useTranslation();

  const actions = [
    {
      label: t('admin.overview.actions.newApp', 'New App'),
      href: '/admin/apps',
      icon: PlusIcon,
      color: 'bg-indigo-600 hover:bg-indigo-700 text-white'
    },
    {
      label: t('admin.overview.actions.addModel', 'Add Model'),
      href: '/admin/models',
      icon: CpuChipIcon,
      color:
        'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600'
    },
    {
      label: t('admin.overview.actions.viewUsage', 'View Usage'),
      href: '/admin/usage',
      icon: ChartBarIcon,
      color:
        'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600'
    },
    {
      label: t('admin.overview.actions.inviteUser', 'Invite User'),
      href: '/admin/users',
      icon: UsersIcon,
      color:
        'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600'
    }
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {actions.map(action => {
        const Icon = action.icon;
        return (
          <Link
            key={action.href}
            to={action.href}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm ${action.color}`}
          >
            <Icon className="w-4 h-4" aria-hidden="true" />
            {action.label}
          </Link>
        );
      })}
    </div>
  );
}

function CommonPages({ className = '' }) {
  const { t } = useTranslation();

  const links = [
    { label: t('admin.nav.apps', 'Apps'), href: '/admin/apps' },
    { label: t('admin.nav.models', 'Models'), href: '/admin/models' },
    { label: t('admin.nav.users', 'Users'), href: '/admin/users' },
    { label: t('admin.nav.authentication', 'Authentication'), href: '/admin/auth' },
    { label: t('admin.nav.integrations', 'Integrations'), href: '/admin/integrations' },
    { label: t('admin.nav.features', 'Features'), href: '/admin/features' },
    { label: t('admin.nav.usage', 'Usage Reports'), href: '/admin/usage' },
    { label: t('admin.nav.backup', 'Backup & Restore'), href: '/admin/backup' }
  ];

  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 ${className}`}
    >
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
        {t('admin.overview.shortcuts', 'Common pages')}
      </h2>
      <nav className="grid grid-cols-2 gap-1">
        {links.map(link => (
          <Link
            key={link.href}
            to={link.href}
            className="flex items-center justify-between px-3 py-2 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            {link.label}
            <ArrowRightIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value, href }) {
  const content = (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  );

  if (href) {
    return (
      <Link
        to={href}
        className="block hover:bg-gray-50 dark:hover:bg-gray-700/50 -mx-2 px-2 rounded"
      >
        {content}
      </Link>
    );
  }

  return content;
}

function PlatformInfoSection({ info }) {
  const { t } = useTranslation();

  if (!info) return null;

  const authLabel = () => {
    const parts = [];
    if (info.auth.local) parts.push(t('admin.overview.auth.local', 'Local'));
    if (info.auth.oidcProviders > 0)
      parts.push(
        t('admin.overview.auth.oidc', 'OIDC ({{count}})', { count: info.auth.oidcProviders })
      );
    if (info.auth.ldapProviders > 0)
      parts.push(
        t('admin.overview.auth.ldap', 'LDAP ({{count}})', { count: info.auth.ldapProviders })
      );
    if (info.auth.proxy) parts.push(t('admin.overview.auth.proxy', 'Proxy'));
    if (info.auth.anonymous) parts.push(t('admin.overview.auth.anonymous', 'Anonymous'));
    return parts.length > 0 ? parts.join(', ') : t('admin.overview.auth.none', 'None');
  };

  const oauthLabel = () => {
    if (info.auth.oauth.authz && info.auth.oauth.clients)
      return t('admin.overview.oauth.serverAndClients', 'Server + Clients');
    if (info.auth.oauth.authz) return t('admin.overview.oauth.server', 'Server');
    if (info.auth.oauth.clients) return t('admin.overview.oauth.clientsOnly', 'Clients only');
    return t('admin.overview.oauth.disabled', 'Disabled');
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
        {t('admin.overview.platformInfo', 'Platform status')}
      </h2>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        <InfoRow
          icon={BoltIcon}
          label={t('admin.overview.providers', 'Providers')}
          value={t('admin.overview.enabledOfTotal', '{{enabled}} / {{total}}', {
            enabled: info.providers.enabled,
            total: info.providers.total
          })}
          href="/admin/providers"
        />
        <InfoRow
          icon={CpuChipIcon}
          label={t('admin.overview.models', 'Models')}
          value={t('admin.overview.enabledOfTotal', '{{enabled}} / {{total}}', {
            enabled: info.models.enabled,
            total: info.models.total
          })}
          href="/admin/models"
        />
        <InfoRow
          icon={CircleStackIcon}
          label={t('admin.overview.sources', 'Sources')}
          value={t('admin.overview.enabledOfTotal', '{{enabled}} / {{total}}', {
            enabled: info.sources.enabled,
            total: info.sources.total
          })}
          href="/admin/sources"
        />
        <InfoRow
          icon={WrenchIcon}
          label={t('admin.overview.tools', 'Tools')}
          value={t('admin.overview.enabledOfTotal', '{{enabled}} / {{total}}', {
            enabled: info.tools.enabled,
            total: info.tools.total
          })}
          href="/admin/tools"
        />
        <InfoRow
          icon={UsersIcon}
          label={t('admin.overview.groups', 'Groups')}
          value={info.groups}
          href="/admin/groups"
        />
        <InfoRow
          icon={ShieldCheckIcon}
          label={t('admin.overview.authMode', 'Authentication')}
          value={authLabel()}
          href="/admin/auth"
        />
        <InfoRow
          icon={KeyIcon}
          label={t('admin.overview.oauth', 'OAuth')}
          value={oauthLabel()}
          href="/admin/oauth"
        />
      </div>
    </div>
  );
}

const ACTION_PILL_COLORS = {
  create: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  update: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  delete: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  toggle: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  import: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  export: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
};

function formatRelativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return new Date(iso).toLocaleString();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function RecentActivityCard({ entries }) {
  const { t } = useTranslation();
  if (!entries) return null;
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.overview.recentActivity', 'Recent activity')}
        </h2>
        <Link
          to="/admin/audit-log"
          className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 inline-flex items-center gap-1"
        >
          {t('admin.overview.viewAll', 'View all')}
          <ArrowRightIcon className="w-3 h-3" />
        </Link>
      </div>
      {entries.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
          {t('admin.overview.noActivity', 'No admin actions recorded yet.')}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700/50">
          {entries.map(e => {
            const color =
              ACTION_PILL_COLORS[e.action] ||
              'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
            return (
              <li key={e.id} className="px-4 py-3 flex items-start gap-3">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${color}`}
                >
                  {e.action}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{e.summary}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    <span className="font-medium">{e.actor?.username ?? e.admin}</span>
                    <span className="mx-1.5">·</span>
                    {e.resource}
                    <span className="mx-1.5">·</span>
                    <time dateTime={e.ts} title={new Date(e.ts).toLocaleString()}>
                      {formatRelativeTime(e.ts)}
                    </time>
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function AdminOverview() {
  const { t, i18n } = useTranslation();
  const { uiConfig } = useUIConfig();
  const { stats, platformInfo, recentActivity, isLoading, isFreshInstance } = useOverviewData();

  const currentLanguage = i18n.language;
  const { titleLight, titleBold, title } = uiConfig?.header ?? {};
  const instanceName =
    titleLight || titleBold
      ? `${getLocalizedContent(titleLight, currentLanguage)}${getLocalizedContent(titleBold, currentLanguage)}`.trim()
      : getLocalizedContent(title, currentLanguage) || 'iHub Apps';

  const statCards = stats
    ? [
        {
          key: 'apps',
          label: t('admin.overview.stats.apps', 'Apps'),
          icon: WindowIcon,
          iconColor: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
          ...stats.apps
        },
        {
          key: 'users',
          label: t('admin.overview.stats.users', 'Users'),
          icon: UsersIcon,
          iconColor: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
          ...stats.users
        },
        {
          key: 'chats',
          label: t('admin.overview.stats.conversations', 'Conversations'),
          icon: ChatBubbleLeftRightIcon,
          iconColor: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
          ...stats.chats
        },
        {
          key: 'version',
          label: t('admin.overview.stats.version', 'Version'),
          icon: TagIcon,
          iconColor: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
          ...stats.version
        }
      ]
    : [];

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-64" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 bg-gray-200 dark:bg-gray-700 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t('admin.overview.title', '{{name}} — Admin', { name: instanceName })}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('admin.overview.subtitle', 'Platform overview and quick actions')}
        </p>
      </div>

      {/* Stat cards */}
      {!isFreshInstance && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {statCards.map(card => (
            <StatCard key={card.key} {...card} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main column */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          {/* Quick actions */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              {t('admin.overview.quickActions', 'Quick actions')}
            </h2>
            <QuickActions />
          </div>

          {/* Recent activity from audit log */}
          {!isFreshInstance && recentActivity && <RecentActivityCard entries={recentActivity} />}

          {/* Common pages — grows to match height of side column */}
          {!isFreshInstance && <CommonPages className="flex-1" />}
        </div>

        {/* Side column */}
        <div className="space-y-6">
          {isFreshInstance ? <SetupChecklist /> : <PlatformInfoSection info={platformInfo} />}
        </div>
      </div>
    </div>
  );
}
