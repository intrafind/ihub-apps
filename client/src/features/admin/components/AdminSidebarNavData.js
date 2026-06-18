import {
  HomeIcon,
  CpuChipIcon,
  BoltIcon,
  SparklesIcon,
  Cog6ToothIcon,
  WindowIcon,
  DocumentTextIcon,
  WrenchIcon,
  CircleStackIcon,
  CodeBracketIcon,
  UsersIcon,
  UserGroupIcon,
  ShieldCheckIcon,
  KeyIcon,
  LinkIcon,
  ChartBarIcon,
  ClipboardDocumentListIcon,
  SignalIcon,
  FlagIcon,
  LockClosedIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  ClipboardDocumentCheckIcon,
  NewspaperIcon
} from '@heroicons/react/24/outline';

/**
 * Returns the 7-section sidebar navigation structure.
 *
 * @param {object} params
 * @param {function} params.t - i18n translation function
 * @param {function} params.showAdminPage - (key: string) => boolean
 * @param {object} params.featureFlags - FeatureFlags instance
 */
export function getAdminNavSections({ t, showAdminPage, featureFlags }) {
  const ff = featureFlags ? featureFlags.isEnabled.bind(featureFlags) : () => true;

  return [
    {
      id: 'overview',
      label: t('admin.sidebar.sections.overview', 'Overview'),
      icon: HomeIcon,
      items: [
        {
          key: 'home',
          label: t('admin.nav.overview', 'Overview'),
          href: '/admin',
          icon: HomeIcon,
          visible: showAdminPage('home')
        }
      ]
    },
    {
      id: 'whatsNew',
      label: t('admin.nav.changelog', "What's New"),
      icon: NewspaperIcon,
      items: [
        {
          key: 'changelog',
          label: t('admin.nav.changelog', "What's New"),
          href: '/admin/changelog',
          icon: NewspaperIcon,
          visible: true
        }
      ]
    },
    {
      id: 'aiWorkspace',
      label: t('admin.sidebar.sections.aiWorkspace', 'AI Workspace'),
      icon: CpuChipIcon,
      items: [
        {
          key: 'apps',
          label: t('admin.nav.apps', 'Apps'),
          href: '/admin/apps',
          icon: WindowIcon,
          visible: showAdminPage('apps')
        },
        {
          key: 'models',
          label: t('admin.nav.models', 'Models'),
          href: '/admin/models',
          icon: CpuChipIcon,
          visible: showAdminPage('models')
        },
        {
          key: 'providers',
          label: t('admin.nav.providers', 'Providers'),
          href: '/admin/providers',
          icon: BoltIcon,
          visible: showAdminPage('providers')
        },
        {
          key: 'prompts',
          label: t('admin.nav.prompts', 'Prompts'),
          href: '/admin/prompts',
          icon: DocumentTextIcon,
          visible: showAdminPage('prompts')
        },
        {
          key: 'tools',
          label: t('admin.nav.tools', 'Tools'),
          href: '/admin/tools',
          icon: WrenchIcon,
          visible: showAdminPage('tools')
        },
        {
          key: 'skills',
          label: t('admin.nav.skills', 'Skills'),
          href: '/admin/skills',
          icon: SparklesIcon,
          visible: showAdminPage('skills') && ff('skills', false)
        },
        {
          key: 'sources',
          label: t('admin.nav.sources', 'Sources'),
          href: '/admin/sources',
          icon: CircleStackIcon,
          visible: showAdminPage('sources')
        },
        {
          key: 'workflows',
          label: t('admin.nav.workflows', 'Workflows'),
          href: '/admin/workflows',
          icon: CodeBracketIcon,
          visible: showAdminPage('workflows') && ff('workflows', false)
        },
        {
          key: 'agents',
          label: t('admin.nav.agents', 'Agents'),
          href: '/admin/agents',
          icon: CpuChipIcon,
          visible: ff('agentFactory', false)
        },
        {
          key: 'marketplace',
          label: t('admin.nav.marketplace', 'Marketplace'),
          href: '/admin/marketplace',
          icon: SparklesIcon,
          visible: ff('marketplace', false)
        }
      ]
    },
    {
      id: 'accessIdentity',
      label: t('admin.sidebar.sections.accessIdentity', 'Access & Identity'),
      icon: ShieldCheckIcon,
      items: [
        {
          key: 'users',
          label: t('admin.nav.users', 'Users'),
          href: '/admin/users',
          icon: UsersIcon,
          visible: showAdminPage('users')
        },
        {
          key: 'groups',
          label: t('admin.nav.groups', 'Groups'),
          href: '/admin/groups',
          icon: UserGroupIcon,
          visible: showAdminPage('groups')
        },
        {
          key: 'auth',
          label: t('admin.nav.authentication', 'Authentication'),
          href: '/admin/auth',
          icon: ShieldCheckIcon,
          visible: showAdminPage('auth')
        },
        {
          key: 'oauth',
          label: t('admin.nav.oauth', 'OAuth'),
          href: '/admin/oauth',
          icon: KeyIcon,
          visible: true
        }
      ]
    },
    {
      id: 'integrations',
      label: t('admin.sidebar.sections.integrations', 'Integrations'),
      icon: LinkIcon,
      items: [
        {
          key: 'integrations',
          label: t('admin.nav.integrations', 'Integrations'),
          href: '/admin/integrations',
          icon: LinkIcon,
          visible: true
        },
        {
          key: 'mcp-servers',
          label: t('admin.nav.mcpServers', 'MCP servers'),
          href: '/admin/mcp/servers',
          icon: LinkIcon,
          visible: true
        },
        {
          key: 'mcp-gateway',
          label: t('admin.nav.mcpGateway', 'MCP gateway'),
          href: '/admin/mcp/gateway',
          icon: LinkIcon,
          visible: true
        },
        {
          key: 'credentials',
          label: t('admin.nav.credentials', 'Credentials'),
          href: '/admin/credentials',
          icon: KeyIcon,
          visible: true
        }
      ]
    },
    {
      id: 'customization',
      label: t('admin.sidebar.sections.customization', 'Customization'),
      icon: SparklesIcon,
      items: [
        {
          key: 'ui',
          label: t('admin.nav.ui', 'UI Customization'),
          href: '/admin/ui',
          icon: SparklesIcon,
          visible: showAdminPage('ui')
        },
        {
          key: 'pages',
          label: t('admin.nav.pages', 'Pages'),
          href: '/admin/pages',
          icon: DocumentTextIcon,
          visible: showAdminPage('pages')
        },
        {
          key: 'shortlinks',
          label: t('admin.nav.shortlinks', 'Short Links'),
          href: '/admin/shortlinks',
          icon: LinkIcon,
          visible: showAdminPage('shortlinks')
        }
      ]
    },
    {
      id: 'observability',
      label: t('admin.sidebar.sections.observability', 'Observability'),
      icon: SignalIcon,
      items: [
        {
          key: 'usage',
          label: t('admin.nav.usage', 'Usage Reports'),
          href: '/admin/usage',
          icon: ChartBarIcon,
          visible: showAdminPage('usage')
        },
        {
          key: 'logging',
          label: t('admin.nav.logging', 'Logging'),
          href: '/admin/logging',
          icon: ClipboardDocumentListIcon,
          visible: showAdminPage('logging')
        },
        {
          key: 'telemetry',
          label: t('admin.nav.telemetry', 'Telemetry'),
          href: '/admin/telemetry',
          icon: SignalIcon,
          visible: showAdminPage('telemetry')
        },
        {
          key: 'audit-log',
          label: t('admin.nav.auditLog', 'Audit Log'),
          href: '/admin/audit-log',
          icon: ClipboardDocumentCheckIcon,
          visible: true
        }
      ]
    },
    {
      id: 'platform',
      label: t('admin.sidebar.sections.platform', 'Platform'),
      icon: Cog6ToothIcon,
      items: [
        {
          key: 'features',
          label: t('admin.nav.features', 'Features'),
          href: '/admin/features',
          icon: FlagIcon,
          visible: showAdminPage('features')
        },
        {
          key: 'security',
          label: t('admin.nav.security', 'Security'),
          href: '/admin/security',
          icon: LockClosedIcon,
          visible: showAdminPage('system')
        },
        {
          key: 'backup',
          label: t('admin.nav.backup', 'Backup & Restore'),
          href: '/admin/backup',
          icon: ArrowDownTrayIcon,
          visible: showAdminPage('system')
        },
        {
          key: 'updates',
          label: t('admin.nav.updates', 'Updates'),
          href: '/admin/updates',
          icon: ArrowPathIcon,
          visible: showAdminPage('system')
        },
        {
          key: 'advanced',
          label: t('admin.nav.advanced', 'Advanced'),
          href: '/admin/advanced',
          icon: ExclamationTriangleIcon,
          visible: showAdminPage('system')
        }
      ]
    }
  ].map(section => ({
    ...section,
    items: section.items.filter(item => item.visible)
  }));
}
