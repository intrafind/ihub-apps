import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  WindowIcon,
  UsersIcon,
  ChatBubbleLeftRightIcon,
  TagIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
  CheckCircleIcon,
  ArrowTopRightOnSquareIcon,
  PlusIcon,
  CpuChipIcon,
  ChartBarIcon,
  ArrowRightIcon
} from '@heroicons/react/24/outline';
import { useOverviewData } from '../hooks/useOverviewData';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

function StatCard({ label, value, sub, href, icon: Icon, iconColor }) {
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
        </div>
        <div className={`p-2.5 rounded-lg ${iconColor} shrink-0 ml-3`}>
          <Icon className="w-5 h-5" aria-hidden="true" />
        </div>
      </div>
      <div className="mt-3 flex items-center text-xs text-indigo-600 dark:text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity">
        <span>View details</span>
        <ArrowRightIcon className="w-3 h-3 ml-1" aria-hidden="true" />
      </div>
    </Link>
  );
}

function SeverityDot({ severity }) {
  const classes = {
    critical: 'bg-red-500',
    warning: 'bg-amber-500',
    info: 'bg-blue-500',
    success: 'bg-green-500'
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 mt-1.5 ${classes[severity] ?? classes.info}`}
      aria-label={severity}
    />
  );
}

function AttentionSection({ items }) {
  const { t } = useTranslation();

  if (items.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
          {t('admin.overview.needsAttention', 'Needs your attention')}
        </h2>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <CheckCircleIcon className="w-4 h-4 text-green-500 shrink-0" aria-hidden="true" />
          <span>{t('admin.overview.allHealthy', 'All systems healthy')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
        {t('admin.overview.needsAttention', 'Needs your attention')}
      </h2>
      <ul className="space-y-3">
        {items.map(item => (
          <li key={item.id} className="flex items-start gap-3">
            <SeverityDot severity={item.severity} />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-700 dark:text-gray-300">{item.message}</p>
            </div>
            {item.actionHref && (
              <Link
                to={item.actionHref}
                className="shrink-0 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 whitespace-nowrap"
              >
                {item.actionLabel ?? 'View'}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
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

export default function AdminOverview() {
  const { t } = useTranslation();
  const { uiConfig } = useUIConfig();
  const { stats, attentionItems, isLoading, isFreshInstance } = useOverviewData();

  const instanceName = uiConfig?.header?.title ?? 'iHub Apps';

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
        <div className="lg:col-span-2 space-y-6">
          {/* Attention items */}
          <AttentionSection items={attentionItems} />

          {/* Quick actions */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              {t('admin.overview.quickActions', 'Quick actions')}
            </h2>
            <QuickActions />
          </div>
        </div>

        {/* Side column */}
        <div className="space-y-6">
          {isFreshInstance ? (
            <SetupChecklist />
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                {t('admin.overview.shortcuts', 'Common pages')}
              </h2>
              <nav className="space-y-1">
                {[
                  { label: t('admin.nav.apps', 'Apps'), href: '/admin/apps' },
                  { label: t('admin.nav.models', 'Models'), href: '/admin/models' },
                  { label: t('admin.nav.users', 'Users'), href: '/admin/users' },
                  { label: t('admin.nav.authentication', 'Authentication'), href: '/admin/auth' },
                  { label: t('admin.nav.features', 'Features'), href: '/admin/features' },
                  { label: t('admin.nav.usage', 'Usage Reports'), href: '/admin/usage' },
                  { label: t('admin.nav.backup', 'Backup & Restore'), href: '/admin/backup' }
                ].map(link => (
                  <Link
                    key={link.href}
                    to={link.href}
                    className="flex items-center justify-between px-3 py-2 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                  >
                    {link.label}
                    <ArrowRightIcon className="w-3.5 h-3.5 text-gray-400" aria-hidden="true" />
                  </Link>
                ))}
              </nav>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
