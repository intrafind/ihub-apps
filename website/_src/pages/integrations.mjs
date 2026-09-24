export default ({ SITE }) => ({
  file: 'integrations.html',
  title: 'Integrations | iHub Apps',
  description:
    'Power your apps and workflows with built-in tools, OpenAPI imports, MCP in both directions, and surfaces where people already work: Outlook, browser, Nextcloud, Microsoft Teams, Jira, Google Drive, Office 365 and iFinder.',
  ogImage: 'admin-integrations.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'Integrations',
      title: 'Plug iHub into the tools you already use.',
      lead: 'Built-in tools, any OpenAPI service, MCP servers in and out, and add-ins for Outlook, the browser and Nextcloud. All governed centrally.',
      ctas: [
        { label: 'Get started', href: SITE.releases, primary: true, icon: 'download' },
        { label: 'Tool calling docs', href: SITE.docsBase + 'tool-calling.md' }
      ],
      image: 'admin-integrations.webp',
      alt: 'The integrations hub in the admin panel.'
    },
    {
      type: 'cards',
      soft: true,
      title: 'Three ways to connect.',
      cols: 3,
      items: [
        {
          icon: 'bolt',
          title: 'Integrate natively',
          text: 'Web search (Brave, Staan, Qwant, native grounding), web content extraction, screenshots, Jira, Microsoft Entra people search, iFinder, iAssistant, Google Drive, Office 365 and Nextcloud file pickers.'
        },
        {
          icon: 'code',
          title: 'Import any OpenAPI service',
          text: 'Paste a spec URL or JSON/YAML, pick the operations the model may call, and use centrally stored credentials. Requests are SSRF-guarded and logged.',
          href: SITE.docsBase + 'tool-calling.md',
          more: 'Read the guide'
        },
        {
          icon: 'puzzle',
          title: 'Add capabilities via MCP',
          text: 'Connect any MCP server over Streamable HTTP or SSE with bearer or OAuth authentication, allowlists and tool prefixes. And expose iHub itself as an MCP server.',
          href: SITE.docsBase + 'mcp-integration.md',
          more: 'MCP documentation'
        }
      ]
    },
    {
      type: 'features',
      title: 'Built-in tools and connectors.',
      items: [
        {
          title: 'Tools with central credentials',
          text: '18 tools ship with the platform, from ask_user and web search to iFinder and Entra people search. Credentials for external services live in one encrypted store and are referenced by tools and models.',
          image: 'admin-tools.webp',
          alt: 'The tools list in the admin panel.'
        },
        {
          title: 'MCP servers as tool providers',
          text: 'Register remote MCP servers, choose which tools to expose, prefix names to avoid collisions and reconnect automatically. Private IP ranges are blocked by default.',
          image: 'admin-mcp-servers.webp',
          alt: 'The MCP servers page in the admin panel.'
        },
        {
          title: 'iHub as an MCP server for Claude, Cursor and VS Code',
          text: 'The MCP gateway exposes your apps, tools, workflows and resources to external agents behind OAuth 2.0 with dynamic client registration. Approve clients individually, revoke connections and run stateless behind a load balancer.',
          image: 'admin-mcp-gateway.webp',
          alt: 'The MCP gateway configuration page.'
        },
        {
          title: 'Jira, Office 365, Google Drive, Nextcloud',
          text: 'Users connect Jira with OAuth and search, read, comment on and transition tickets from chat. File pickers bring documents from OneDrive, SharePoint, Teams libraries, Google Drive and Nextcloud into any app.',
          image: 'admin-integrations-jira.webp',
          alt: 'The Jira integration settings page.'
        }
      ]
    },
    {
      type: 'features',
      soft: true,
      title: 'Bring iHub to where people work.',
      items: [
        {
          id: 'outlook',
          title: 'Outlook add-in',
          text: 'Summarize the open thread, reply, reply all, forward or draft a new mail, insert into the draft, and prepare for the meeting in the open calendar item. Deployed centrally from the Microsoft 365 admin center.',
          bullets: [
            'Desktop, web and mobile Outlook',
            'Attachments as context',
            'Attach documents found in iAssistant'
          ],
          image: 'admin-office.webp',
          alt: 'Outlook add-in configuration page.',
          link: { label: 'Outlook add-in rollout', href: SITE.docsBase + 'outlook-add-in.md' }
        },
        {
          id: 'browser',
          title: 'Browser extension',
          text: 'A side panel for Chrome, Edge and Firefox that sends the current page to any app. Signed CRX or ZIP builds, OAuth with PKCE, no data stored in the extension.',
          image: 'admin-browser-extension.webp',
          alt: 'Browser extension download and configuration page.',
          link: { label: 'Browser extension docs', href: SITE.docsBase + 'browser-extension.md' }
        },
        {
          id: 'nextcloud',
          title: 'Nextcloud app and embed',
          text: '“Chat with iHub” inside Nextcloud Files, plus an embeddable full-page view protected by OAuth and a frame-ancestors policy.',
          image: 'admin-nextcloud-embed.webp',
          alt: 'Nextcloud embed configuration page.',
          link: { label: 'Nextcloud integration', href: SITE.docsBase + 'nextcloud-integration.md' }
        },
        {
          id: 'teams',
          title: 'Microsoft Teams tab',
          text: 'A personal tab with Teams single sign-on, so the whole workspace is one click away inside Teams.',
          image: 'admin-integrations-office365.webp',
          alt: 'Office 365 integration settings.'
        }
      ]
    },
    {
      type: 'features',
      title: 'Enterprise knowledge from IntraFind.',
      items: [
        {
          title: 'iFinder and iAssistant',
          text: 'Use IntraFind iFinder as a knowledge source with the user’s own permissions: pin a document or drive a search query. iAssistant adds grounded retrieval-augmented answers as a model in its own right.',
          bullets: [
            'Seven iFinder tools: search, content, metadata, facets, profiles',
            'JWT or OIDC identity pass-through',
            'Audit-grade quote validation for reviews'
          ],
          image: 'admin-sources.webp',
          alt: 'The sources list with iFinder, file and URL sources.',
          link: { label: 'iFinder integration', href: SITE.docsBase + 'iFinder-Integration.md' }
        }
      ]
    },
    {
      type: 'html',
      soft: true,
      html: `<div class="section-head center"><h2>Catalogue</h2><p class="lead">Everything that ships or connects today.</p></div>
      <div class="grid cols-3">
        <div class="card"><h3>Search & web</h3><ul class="inline-list"><li>Brave Search</li><li>Staan (EU)</li><li>Qwant</li><li>Google grounding</li><li>OpenAI web search</li><li>Anthropic web search</li><li>Web content extractor</li><li>Playwright screenshot</li><li>Selenium screenshot</li></ul></div>
        <div class="card"><h3>Enterprise systems</h3><ul class="inline-list"><li>Jira</li><li>Microsoft Entra</li><li>iFinder</li><li>iAssistant</li><li>Office 365 / SharePoint / OneDrive</li><li>Google Drive</li><li>Nextcloud</li><li>Any OpenAPI service</li></ul></div>
        <div class="card"><h3>Surfaces</h3><ul class="inline-list"><li>Outlook add-in</li><li>Browser extension</li><li>Nextcloud app</li><li>Microsoft Teams tab</li><li>PWA</li><li>OpenAI-compatible API</li><li>MCP gateway</li><li>A2A (experimental)</li></ul></div>
        <div class="card"><h3>Protocols</h3><ul class="inline-list"><li>MCP client</li><li>MCP server</li><li>OAuth 2.0 / OIDC</li><li>Dynamic client registration</li><li>CIMD</li><li>HMAC webhooks</li><li>SSE v2</li></ul></div>
        <div class="card"><h3>Identity</h3><ul class="inline-list"><li>OIDC (Entra, Google, Keycloak, Okta, Auth0)</li><li>ADFS</li><li>LDAP</li><li>NTLM</li><li>Proxy / JWT</li><li>Teams SSO</li><li>Local accounts</li></ul></div>
        <div class="card"><h3>Agent tools</h3><ul class="inline-list"><li>ask_user</li><li>evidence</li><li>create_task</li><li>list_tasks</li><li>mark_task_done</li><li>read/write inbox</li><li>read/write memory</li><li>write_artifact</li></ul></div>
      </div>`
    },
    {
      type: 'faq',
      items: [
        {
          q: 'Can I connect a service that is not listed?',
          a: 'Yes. Import its OpenAPI specification as a tool, connect it through an MCP server, or write a small script tool. Credentials are stored centrally and encrypted.'
        },
        {
          q: 'Is the integration secure?',
          a: 'Outbound calls pass an SSRF guard, private ranges are blocked unless allowlisted, secrets are AES-256-GCM encrypted, and every tool call appears in the audit log and the run ledger.'
        },
        {
          q: 'Can other AI clients use my iHub apps?',
          a: 'Yes. The MCP gateway exposes apps, tools and workflows to Claude Desktop, claude.ai, Cursor and VS Code behind OAuth 2.0, and the OpenAI-compatible API works with the OpenAI SDKs, LangChain and LlamaIndex.'
        },
        {
          q: 'Do users need to authenticate with each service?',
          a: 'Depends on the service. Jira and the cloud file pickers use the user’s own OAuth login. Central credentials are used for service accounts such as web search or OpenAPI tools.'
        }
      ]
    },
    { type: 'crosssell', exclude: 'integrations.html' },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
