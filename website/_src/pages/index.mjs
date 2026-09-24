export default ({ SITE }) => ({
  file: 'index.html',
  title: 'iHub Apps | The open-source platform for AI adoption',
  description:
    'iHub Apps gives your whole organization governed access to AI: ready-made apps, model-agnostic chat, workflows, agents and integrations. Self-hosted, open source, made in Germany.',
  ogImage: 'chat-answer.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'Open source · self-hosted · model agnostic',
      title: 'The platform for AI adoption you can run yourself.',
      lead: 'iHub Apps rolls out AI across your entire organization in a safe and flexible way: 24 ready-made apps, every major model, workflows and agents, and full control over where your data lives.',
      ctas: [
        {
          label: 'Download and run in 60 seconds',
          href: SITE.releases,
          primary: true,
          icon: 'download'
        },
        { label: 'Talk to IntraFind', href: SITE.contact }
      ],
      sub: 'Free and open source. No account, no credit card, no data leaving your network.',
      image: 'chat-answer.webp',
      alt: 'iHub Apps chat interface answering a question about how a team can use the platform, with app sidebar, model selector and recent chats.'
    },
    {
      type: 'stats',
      soft: true,
      title: 'Everything a company needs to adopt AI, in one deployable package.',
      items: [
        { value: '24 + 43', label: 'apps shipped, plus example apps and a marketplace' },
        { value: '8', label: 'model provider adapters, cloud and local' },
        { value: '26', label: 'workflow node types in the visual builder' },
        { value: '2 ×', label: 'MCP: client and OAuth-gated gateway' },
        { value: 'EN · DE', label: 'interface languages, fully white-label' },
        { value: '0', label: 'databases required to get started' }
      ],
      note: `Numbers from the iHub Apps ${SITE.version} source tree.`
    },
    {
      type: 'cards',
      title: 'The essential AI stack for your company.',
      lead: 'Simple for business users. Ready for advanced use cases. Governed by IT.',
      cols: 3,
      items: [
        {
          icon: 'chat',
          title: 'Chat',
          text: 'Model agnostic. For everyone in the company, with files, voice, web search and citations.',
          href: 'chat.html'
        },
        {
          icon: 'apps',
          title: 'Apps',
          text: 'Ready-made assistants for recurring tasks: prompts, variables, knowledge and tools, rolled out per team.',
          href: 'apps.html'
        },
        {
          icon: 'workflow',
          title: 'Workflows & Agents',
          text: 'Build multi-step automation with human approval, schedules and webhooks.',
          href: 'workflows.html',
          badge: 'Preview',
          badgeClass: 'preview'
        },
        {
          icon: 'plug',
          title: 'Integrations',
          text: 'Outlook, browser extension, Nextcloud, Teams, Jira, iFinder, OpenAPI tools and MCP.',
          href: 'integrations.html'
        },
        {
          icon: 'code',
          title: 'API',
          text: 'OpenAI-compatible inference API, MCP gateway and a built-in OAuth 2.0 server.',
          href: 'api.html'
        },
        {
          icon: 'cpu',
          title: 'Models',
          text: 'OpenAI, Anthropic, Google, Mistral, AWS Bedrock, Azure and any local OpenAI-compatible server.',
          href: 'models.html'
        }
      ]
    },
    {
      type: 'features',
      soft: true,
      title: 'One interface for every team.',
      lead: 'Users pick an app, type or dictate, and get a governed answer. Admins decide which teams see which apps and models.',
      items: [
        {
          title: 'A catalogue of apps instead of a blank prompt.',
          text: 'Email Composer, Summarizer, Translator, Meeting Briefing, NDA Risk Analyzer, Diagram Generator, File Analyzer and more ship out of the box. Every app carries an expert prompt, so nobody needs prompting skills.',
          bullets: [
            'Search, categories and favourites',
            'Starter prompts and input forms per app',
            'Rolled out per group, including LDAP and OIDC groups'
          ],
          image: 'apps.webp',
          alt: 'The iHub Apps catalogue with search, category filters and app cards such as Email Composer, Meeting Briefing and NDA Risk Analyzer.',
          link: { label: 'Explore apps', href: 'apps.html' }
        },
        {
          title: 'Automation with a human in the loop.',
          text: 'Design multi-step workflows on a visual canvas: AI steps, decisions, loops, parallel branches, HTTP calls, code and approval checkpoints. Trigger them manually, on a schedule or via webhook.',
          bullets: [
            '26 node types, draft and published versions',
            'Run history, crash-resume, export',
            'Autonomous agents with memory, inboxes and budgets'
          ],
          image: 'workflow-editor.webp',
          alt: 'The iHub workflow editor showing a Research Assistant workflow with Start, Planner, Web Searcher, Synthesizer and End nodes on a canvas.',
          link: { label: 'See workflows and agents', href: 'workflows.html' }
        },
        {
          title: 'Central governance and admin controls.',
          text: 'One admin panel for apps, models, providers, prompts, tools, skills, sources, users, groups, authentication, integrations, usage and audit. Every change is versioned with a before/after diff.',
          bullets: [
            'Hierarchical groups with external mappings',
            'Audit log, usage reports, telemetry',
            'Backup, restore and self-update'
          ],
          image: 'admin-overview.webp',
          alt: 'The iHub admin overview with statistics for apps, users and conversations, platform status and quick actions.',
          link: { label: 'Enterprise features', href: 'enterprise.html' }
        }
      ]
    },
    {
      type: 'cards',
      title: 'The all-in-one platform to adopt AI as an organization.',
      cols: 3,
      softCards: true,
      items: [
        {
          icon: 'cpu',
          title: 'Model agnostic',
          text: 'No vendor lock-in. Switch between GPT, Claude, Gemini, Mistral, Bedrock or a local vLLM per app, per group or per chat.'
        },
        {
          icon: 'shield',
          title: 'Security first',
          text: 'Runs inside your network. OIDC, LDAP, NTLM and proxy authentication; secrets encrypted at rest; rate limiting and SSRF guards.'
        },
        {
          icon: 'sparkles',
          title: 'Customizable',
          text: 'Your logo, colours, pages and disclaimers. Custom React renderers for structured answers. English and German out of the box.'
        },
        {
          icon: 'building',
          title: 'Enterprise ready',
          text: 'Group-based permissions, audit log, usage reports, OpenTelemetry, change history and in-product release notes.'
        },
        {
          icon: 'server',
          title: 'Deployable anywhere',
          text: 'Single binary, Docker image, npm, Windows service. Laptop, data centre, private cloud or air-gapped.'
        },
        {
          icon: 'puzzle',
          title: 'Interoperability built in',
          text: 'OpenAI-compatible API, MCP in both directions, OpenAPI tool import, OAuth 2.0 server, experimental A2A.'
        }
      ]
    },
    {
      type: 'bento',
      soft: true,
      title: 'Works the way your people already work.',
      items: [
        {
          title: 'Compare models side by side',
          text: 'Send one prompt to two models and see the answers next to each other before you standardize on one.',
          image: 'chat-compare.webp',
          alt: 'Compare mode with Claude Fable 5.1 and Claude Haiku 4.5 answering the same prompt side by side.',
          badge: 'Preview',
          badgeClass: 'preview'
        },
        {
          title: 'Dark mode and mobile',
          text: 'A responsive React interface with light, dark and system themes, installable as a PWA.',
          image: 'chat-answer-dark.webp',
          alt: 'The iHub chat in dark mode.'
        },
        {
          title: 'Outlook, browser and Nextcloud',
          text: 'Reply to the open email, send the current web page to an app, or chat with a file inside Nextcloud.',
          image: 'admin-office.webp',
          alt: 'Admin page for the Outlook add-in rollout.'
        },
        {
          title: 'Diagrams, documents and structured output',
          text: 'Mermaid diagrams with SVG, PNG and PDF export, a document canvas, and JSON schemas rendered by custom components.',
          image: 'chat-mermaid.webp',
          alt: 'The Diagram Generator app rendering a purchase approval flowchart with export buttons.'
        }
      ]
    },
    {
      type: 'steps',
      title: 'From download to first answer in three steps.',
      items: [
        {
          title: 'Install',
          text: 'Download the standalone binary for Linux, macOS or Windows, or pull the Docker image.',
          code: 'curl -fsSL https://raw.githubusercontent.com/intrafind/ihub-apps/main/install.sh | sh'
        },
        {
          title: 'Connect a model',
          text: 'Open http://localhost:3000, log in as the default admin and add an API key, or point iHub at your local vLLM or LM Studio.',
          code: 'Settings → Models → Add API key'
        },
        {
          title: 'Roll out',
          text: 'Enable the apps your teams need, map your directory groups, and share the link. Everything else is configured in the admin UI.',
          code: 'Admin → Groups → map "Employees" → apps: *'
        }
      ]
    },
    {
      type: 'cards',
      soft: true,
      title: 'Guiding you step by step.',
      lead: 'Learn how iHub Apps fits your organization.',
      cols: 3,
      items: [
        {
          icon: 'book',
          title: 'Core concepts',
          text: 'Providers, models, apps, skills, sources, tools, prompts and groups: when to use which.',
          href: SITE.docsBase + 'concepts.md',
          more: 'Read the guide'
        },
        {
          icon: 'building',
          title: 'Enterprise deployment',
          text: 'Reverse proxies, SSL, multi-worker scaling, Windows service, multi-server setups.',
          href: 'enterprise.html',
          more: 'See deployment options'
        },
        {
          icon: 'clock',
          title: 'What shipped recently',
          text: 'Every release adds features, fixes and the occasional breaking change. The changelog is also inside the product.',
          href: 'changelog.html',
          more: 'Open changelog'
        }
      ]
    },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
