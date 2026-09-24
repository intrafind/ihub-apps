export default ({ SITE }) => ({
  file: 'enterprise.html',
  title: 'Enterprise | iHub Apps',
  description:
    'Central governance and admin controls for AI at scale: one admin panel for apps, models, users, groups, integrations and usage; backup, self-update, change history, white-labeling and multi-server deployment.',
  ogImage: 'admin-overview.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'Enterprise',
      title: 'Central governance for AI across the whole company.',
      lead: 'One admin panel controls what every team may use, how it looks, where data goes and what it costs. Deploy it on your terms, from a single server to a multi-worker cluster.',
      ctas: [
        { label: 'Talk to IntraFind', href: SITE.contact, primary: true },
        { label: 'Admin UI guide', href: SITE.docsBase + 'admin-ui.md' }
      ],
      image: 'admin-overview.webp',
      alt: 'The admin overview dashboard with statistics and platform status.'
    },
    {
      type: 'cards',
      soft: true,
      title: 'Everything IT needs in one place.',
      cols: 3,
      items: [
        {
          icon: 'apps',
          title: 'AI workspace',
          text: 'Apps, models, providers, prompts, tools, skills, sources, workflows, agents and marketplace.'
        },
        {
          icon: 'users',
          title: 'Access & identity',
          text: 'Users, hierarchical groups, authentication providers, OAuth clients and connections.'
        },
        {
          icon: 'plug',
          title: 'Integrations',
          text: 'Outlook, browser extension, Nextcloud, Google Drive, Office 365, Jira, MCP servers, MCP gateway, credentials.'
        },
        {
          icon: 'sparkles',
          title: 'Customization',
          text: 'Header, footer, start page, theme, assets, error pages, PWA, pages, short links and localization.'
        },
        {
          icon: 'chart',
          title: 'Observability',
          text: 'Usage reports, feedback, logging level, telemetry, chat history statistics and the audit log.'
        },
        {
          icon: 'server',
          title: 'Platform',
          text: 'Feature flags, voice input, security, backup and restore, updates with rollback, advanced settings.'
        }
      ]
    },
    {
      type: 'features',
      title: 'Built for operations teams.',
      items: [
        {
          title: 'Command palette, keyboard shortcuts, change history',
          text: 'Jump anywhere with Cmd+K. Every entity has a history drawer with before/after diffs and an unsaved-changes guard. What’s New shows the release notes for the version you just installed.',
          image: 'admin-command-palette.webp',
          alt: 'The admin command palette open over the apps list.'
        },
        {
          title: 'Backup, restore and self-update',
          text: 'Download the whole configuration as a ZIP, restore it with an automatic pre-import backup, and update the binary in place with rollback. Configuration changes are versioned Flyway-style with 120+ migrations applied on start.',
          image: 'admin-backup.webp',
          alt: 'The backup and restore page.'
        },
        {
          title: 'Feature flags for a controlled rollout',
          text: 'Preview features such as Workflows, Agents, Skills, Marketplace, Durable Chats and Compare Mode are switched on when you are ready. Core features can be disabled for a leaner deployment.',
          image: 'admin-features.webp',
          alt: 'The feature flags page.'
        },
        {
          title: 'Your brand, your languages',
          text: 'Logo, colours, title, tagline, footer, disclaimer, pages such as FAQ, privacy and terms, error pages and a PWA manifest. English and German ship; override any string, and let the AI translate admin-authored text.',
          image: 'admin-ui.webp',
          alt: 'The UI customization page.'
        },
        {
          title: 'Usage and feedback at a glance',
          text: 'Tokens by app, model and user with a timeline and CSV export. Star ratings and comments from users land in the feedback page for review.',
          image: 'admin-usage.webp',
          alt: 'Usage reports with charts.'
        }
      ]
    },
    {
      type: 'table',
      soft: true,
      title: 'Deployment and scaling',
      columns: ['Topic', 'What iHub provides', 'Docs'],
      rows: [
        [
          'Install',
          'One-line installer, single binary (Linux, macOS, Windows), Docker image, npm, Windows service',
          `<a href="${SITE.docsBase}INSTALLATION.md" target="_blank" rel="noopener">Installation</a>`
        ],
        [
          'Zero-config start',
          'Default configuration generated on first run, setup wizard for the first API key, no database',
          `<a href="${SITE.docsBase}GETTING_STARTED.md" target="_blank" rel="noopener">Getting started</a>`
        ],
        [
          'Reverse proxy & subpath',
          'nginx and Apache examples, X-Forwarded-Prefix detection, SSL termination',
          `<a href="${SITE.docsBase}production-reverse-proxy-guide.md" target="_blank" rel="noopener">Reverse proxy</a>`
        ],
        [
          'Scaling',
          'Multi-worker cluster on one host; multi-server with a sticky load balancer and shared content volume',
          `<a href="${SITE.docsBase}scaling.md" target="_blank" rel="noopener">Scaling</a>`
        ],
        [
          'Networks',
          'Outbound HTTP proxy, SSL allowlists, SSRF guard, CORS for embedded deployments',
          `<a href="${SITE.docsBase}proxy-configuration.md" target="_blank" rel="noopener">Proxy</a>`
        ],
        [
          'Observability',
          'OpenTelemetry (OTLP, Prometheus), structured logging, health endpoint, run ledger',
          `<a href="${SITE.docsBase}telemetry.md" target="_blank" rel="noopener">Telemetry</a>`
        ],
        [
          'Configuration',
          'JSON under one content folder, hot reload, versioned migrations, validation',
          `<a href="${SITE.docsBase}configuration.md" target="_blank" rel="noopener">Configuration</a>`
        ],
        [
          'Support',
          'Community on GitHub; enterprise support, custom features and hosting from IntraFind',
          `<a href="${SITE.contact}">sales@intrafind.com</a>`
        ]
      ]
    },
    {
      type: 'cards',
      title: 'Why organizations choose iHub Apps.',
      cols: 3,
      softCards: true,
      items: [
        {
          icon: 'lock',
          title: 'Full data control',
          text: 'On-premise, private cloud or air-gapped. Local models for sensitive work.'
        },
        {
          icon: 'cpu',
          title: 'No vendor lock-in',
          text: 'Any model, any provider, switchable per app and per group.'
        },
        {
          icon: 'layers',
          title: 'Enterprise knowledge',
          text: 'iFinder and iAssistant bring permission-aware enterprise search into every app.'
        },
        {
          icon: 'users',
          title: 'No prompting skills required',
          text: 'Expert prompts ship with every app. Teams get value on day one.'
        },
        {
          icon: 'shield',
          title: 'Enterprise-grade security',
          text: 'SSO, LDAP, NTLM, encryption at rest, audit log, rate limiting.'
        },
        {
          icon: 'terminal',
          title: 'Extensible without coding',
          text: 'Apps, models, sources and tools through the admin UI; full source code for everything else.'
        }
      ]
    },
    {
      type: 'faq',
      items: [
        {
          q: 'How many users can one deployment serve?',
          a: 'A single server with several workers handles departments comfortably; a multi-server setup behind a sticky load balancer scales further. Model throughput is usually the limit, not iHub.'
        },
        {
          q: 'Do we need a database?',
          a: 'No. Configuration and runtime data live in a content folder as JSON and JSONL. A pluggable storage interface prepares for PostgreSQL and object storage.'
        },
        {
          q: 'How do upgrades work?',
          a: 'Binary installs update themselves from the admin UI with rollback; Docker deployments pull a new image. Configuration migrations run automatically and are forward-only.'
        },
        {
          q: 'What does IntraFind offer beyond the open-source product?',
          a: 'Enterprise support, hosting and GPU inference in German data centres, custom apps and integrations, and the iFinder and iAssistant enterprise search products.'
        }
      ]
    },
    {
      type: 'cta',
      title: 'Plan your rollout with IntraFind.',
      text: 'Start with the free download for a pilot department, then talk to us about support, hosting and enterprise search integration.'
    },
    { type: 'trust' }
  ]
});
