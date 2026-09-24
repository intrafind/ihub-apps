export default ({ SITE }) => {
  const d = p => SITE.docsBase + p;
  return {
    file: 'docs.html',
    title: 'Documentation | iHub Apps',
    description:
      'Product guides for users, admins and developers: getting started, chat, apps, workflows and agents, integrations, models, authentication, security, deployment and the API.',
    sections: [
      {
        type: 'hero',
        eyebrow: 'Documentation',
        title: 'Welcome to the iHub Apps product guide.',
        lead: 'Everything you need to run, configure, use and extend iHub Apps. The full documentation is maintained in the repository and served inside every installation.',
        ctas: [
          { label: 'Open the documentation', href: SITE.docs, primary: true, icon: 'book' },
          { label: 'Getting started', href: d('GETTING_STARTED.md') }
        ]
      },
      {
        type: 'cards',
        soft: true,
        title: 'Start with a product area.',
        cols: 4,
        docs: true,
        items: [
          {
            icon: 'chat',
            title: 'Chat',
            text: 'Chat interface, message controls, model selection, history, prompt library and compare mode.',
            href: d('user-guide.md'),
            more: 'User guide'
          },
          {
            icon: 'apps',
            title: 'Apps',
            text: 'App configuration, variables, sources, tools, renderers and the creation wizard.',
            href: d('apps.md'),
            more: 'App configuration'
          },
          {
            icon: 'code',
            title: 'API',
            text: 'OpenAI-compatible inference API, OAuth flows, personal API keys and SSE v2 streaming.',
            href: d('openai-compatible-api.md'),
            more: 'API docs'
          },
          {
            icon: 'plug',
            title: 'Integrations',
            text: 'Tool calling, MCP, Jira, Office 365, Google Drive, Nextcloud, Outlook add-in and browser extension.',
            href: d('tool-calling.md'),
            more: 'Integrations'
          },
          {
            icon: 'workflow',
            title: 'Workflows & Agents',
            text: 'Visual editor, node types, triggers, versions, executions and the Agent Factory.',
            href: d('workflows.md'),
            more: 'Workflows'
          },
          {
            icon: 'layers',
            title: 'Sources & knowledge',
            text: 'File, URL, page and iFinder sources; prompt or on-demand exposure; caching.',
            href: d('sources.md'),
            more: 'Sources'
          },
          {
            icon: 'sparkles',
            title: 'Skills',
            text: 'Agent Skills standard, SKILL.md structure, assignment to apps and permissions.',
            href: d('architecture.md'),
            more: 'Architecture'
          },
          {
            icon: 'cpu',
            title: 'Models',
            text: 'Providers, model files, capability flags, local LLM servers and vLLM parameters.',
            href: d('models.md'),
            more: 'Models'
          }
        ]
      },
      {
        type: 'cards',
        title: 'By role.',
        cols: 3,
        items: [
          {
            icon: 'users',
            title: 'Using iHub',
            text: 'Launch an app, chat, upload files, dictate, compare models, use the prompt library and keep your history.',
            href: d('user-guide.md'),
            more: 'User guide'
          },
          {
            icon: 'shield',
            title: 'Admin',
            text: 'Admin UI, authentication and groups, security, platform configuration, migrations, backup, updates, telemetry and operations.',
            href: d('admin-ui.md'),
            more: 'Admin UI guide'
          },
          {
            icon: 'terminal',
            title: 'Developer',
            text: 'Architecture, LLM client, agent loop, SSE v2, run ledger, storage providers, React pages, custom renderers, release process.',
            href: d('developer-onboarding.md'),
            more: 'Developer onboarding'
          }
        ]
      },
      {
        type: 'table',
        soft: true,
        title: 'Popular guides',
        columns: ['Topic', 'Guide'],
        rows: [
          [
            'Install in 60 seconds',
            `<a href="${d('INSTALLATION.md')}" target="_blank" rel="noopener">Installation guide</a>`
          ],
          [
            'Core concepts: providers, models, apps, skills, sources, tools',
            `<a href="${d('concepts.md')}" target="_blank" rel="noopener">Core concepts</a>`
          ],
          [
            'Single sign-on with OIDC, ADFS, LDAP or NTLM',
            `<a href="${d('external-authentication.md')}" target="_blank" rel="noopener">External authentication</a>`
          ],
          [
            'Local models with vLLM, LM Studio or Ollama',
            `<a href="${d('local-llm-providers.md')}" target="_blank" rel="noopener">Local LLM providers</a>`
          ],
          [
            'Web search providers and content extraction',
            `<a href="${d('web-tools.md')}" target="_blank" rel="noopener">Web tools</a>`
          ],
          [
            'MCP client and gateway',
            `<a href="${d('mcp-integration.md')}" target="_blank" rel="noopener">MCP integration</a>`
          ],
          [
            'Outlook add-in rollout',
            `<a href="${d('outlook-add-in.md')}" target="_blank" rel="noopener">Outlook add-in</a>`
          ],
          [
            'Reverse proxy, SSL and subpath deployment',
            `<a href="${d('production-reverse-proxy-guide.md')}" target="_blank" rel="noopener">Production reverse proxy</a>`
          ],
          [
            'Scaling with workers and multiple servers',
            `<a href="${d('multi-server-deployment.md')}" target="_blank" rel="noopener">Multi-server deployment</a>`
          ],
          [
            'Personal data and GDPR',
            `<a href="${d('pii-data-handling.md')}" target="_blank" rel="noopener">PII data handling</a>`
          ],
          [
            'Frequently asked questions (EN / DE)',
            `<a href="${d('ihub-faq-en.md')}" target="_blank" rel="noopener">FAQ English</a> · <a href="${d('ihub-faq-de.md')}" target="_blank" rel="noopener">FAQ Deutsch</a>`
          ]
        ]
      },
      {
        type: 'cta',
        title: 'Prefer to learn by doing?',
        text: 'Install iHub Apps locally, open Admin → What’s New, and follow the setup checklist on the overview page.'
      },
      { type: 'trust' }
    ]
  };
};
