export default ({ SITE }) => ({
  file: 'api.html',
  title: 'Enterprise AI API | iHub Apps',
  description:
    'One OpenAI-compatible API in front of every model your organization allows, filtered by user and group permissions. Plus an MCP gateway, a built-in OAuth 2.0 server, personal API keys and a documented REST API.',
  ogImage: 'api-docs.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'For developers',
      title: 'One API. All models. Your permissions.',
      lead: 'Integrate every model your organization allows into your own applications with a single OpenAI-compatible API, governed by the same groups and audit trail as the chat.',
      ctas: [
        {
          label: 'OpenAI-compatible API docs',
          href: SITE.docsBase + 'openai-compatible-api.md',
          primary: true,
          icon: 'code'
        },
        { label: 'API examples', href: SITE.docsBase + 'oauth-api-examples.md' }
      ],
      image: 'api-docs.webp',
      alt: 'Swagger UI showing the iHub Apps REST API with grouped endpoints.'
    },
    {
      type: 'cards',
      soft: true,
      title: 'Four surfaces for builders.',
      cols: 4,
      items: [
        {
          icon: 'code',
          title: 'Inference API',
          text: 'OpenAI-compatible chat completions and model listing with streaming and tool calling. Works with the OpenAI SDKs, LangChain and LlamaIndex.',
          href: SITE.docsBase + 'openai-compatible-api.md'
        },
        {
          icon: 'apps',
          title: 'Apps & runs API',
          text: 'Start app chats, workflows and agent runs, stream progress over SSE v2 with sequence numbers and reconnect, answer human-in-the-loop questions.',
          href: SITE.docsBase + 'sse-v2.md'
        },
        {
          icon: 'puzzle',
          title: 'MCP gateway',
          text: 'Expose apps, tools, workflows and resources to Claude, Cursor and VS Code behind OAuth 2.0 with dynamic client registration.',
          href: SITE.docsBase + 'mcp-integration.md'
        },
        {
          icon: 'key',
          title: 'OAuth 2.0 & OIDC provider',
          text: 'Client credentials, authorization code with PKCE, refresh tokens, introspection, JWKS. iHub can be the identity provider for your other tools.',
          href: SITE.docsBase + 'ihub-as-oidc-idp.md'
        }
      ]
    },
    {
      type: 'features',
      title: 'Drop-in for existing code.',
      items: [
        {
          title: 'Point your OpenAI client at iHub',
          text: 'Change the base URL and the key. Users see only the models their groups allow; every request is attributed, rate-limited and logged. Credentials can be a session token, an OAuth client, a static key or a personal API key.',
          html: `<pre><code>import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://ihub.example.com/api/inference/v1',
  apiKey: process.env.IHUB_PERSONAL_API_KEY
});

const stream = await client.chat.completions.create({
  model: 'claude-sonnet-5',
  stream: true,
  messages: [{ role: 'user', content: 'Summarize this contract…' }]
});</code></pre>`
        },
        {
          title: 'Personal API keys that act as the user',
          text: 'Users create keys in their profile. A key carries the user’s permissions, never admin rights, and can be revoked at any time. Ideal for scripts, Claude Code, Copilot or Codex style tools.',
          image: 'admin-oauth.webp',
          alt: 'OAuth overview page in the admin panel.'
        },
        {
          title: 'A real authorization server',
          text: 'Register OAuth clients, approve dynamically registered MCP clients with client metadata documents, manage consents and connections, and rotate signing keys. Discovery and JWKS endpoints make iHub an OIDC identity provider.',
          image: 'admin-oauth-server.webp',
          alt: 'The OAuth authorization server settings page.'
        },
        {
          title: 'Swagger UI included',
          text: 'Three OpenAPI specifications are served by every installation: the public API, the admin API and the OpenAI-compatible API. Try requests directly from the browser.',
          image: 'api-docs.webp',
          alt: 'Swagger UI for the iHub Apps API.'
        }
      ]
    },
    {
      type: 'table',
      soft: true,
      title: 'Endpoint groups',
      columns: ['Group', 'What it does', 'Auth'],
      rows: [
        [
          '<code>/api/inference/v1</code>',
          'OpenAI-compatible <code>/models</code> and <code>/chat/completions</code>, streaming, tool calling',
          'Session, OAuth client, static or personal key'
        ],
        [
          '<code>/api/apps</code>, <code>/api/chats</code>',
          'List apps, run app chats, stop, status, durable chat history',
          'Session or personal key'
        ],
        [
          '<code>/api/runs</code>',
          'Run events, interactions, human answers for chats, workflows and agents',
          'Session or personal key'
        ],
        [
          '<code>/api/workflows</code>',
          'Execute, trigger, versions, publish, stream, export, resume',
          'Session, key or HMAC webhook'
        ],
        [
          '<code>/api/agents</code>',
          'Profiles, runs, artifacts, stream, resume, cancel',
          'Session or key'
        ],
        [
          '<code>/api/models</code>, <code>/api/tools</code>, <code>/api/skills</code>, <code>/api/prompts</code>',
          'Catalogue endpoints filtered by permissions',
          'Session or key'
        ],
        [
          '<code>/mcp</code>',
          'MCP gateway: tools, apps, workflows, resources',
          'OAuth 2.0 with DCR'
        ],
        [
          '<code>/a2a</code>',
          'Agent-to-agent: agent/info, agent/skills, tasks/send (experimental)',
          'OAuth 2.0'
        ],
        [
          '<code>/api/admin/*</code>',
          'Everything the admin UI does, including migrations, backup and telemetry',
          'Admin session'
        ],
        ['<code>/api/docs</code>', 'Swagger UI with public, admin and OpenAI specs', 'Public']
      ]
    },
    {
      type: 'faq',
      items: [
        {
          q: 'Which models are available through the API?',
          a: 'Every model configured in iHub and allowed for the calling user’s groups: OpenAI, Anthropic, Google, Mistral, AWS Bedrock, Azure OpenAI and local OpenAI-compatible servers.'
        },
        {
          q: 'Can I call an app instead of a raw model?',
          a: 'Yes. The apps API runs a full app chat with its prompt, tools and sources; the run API streams progress and lets you answer human-in-the-loop questions.'
        },
        {
          q: 'How do I authenticate?',
          a: 'With the user’s session or SSO token, an OAuth 2.0 client (client credentials or authorization code with PKCE), a static server key, or a personal API key created in the user profile.'
        },
        {
          q: 'Are there rate limits?',
          a: 'Yes, in six categories (default, admin, public, auth, OAuth, inference), configurable per deployment. Request concurrency towards providers is throttled as well.'
        },
        {
          q: 'Is there an embeddings endpoint?',
          a: 'Not yet. iHub focuses on inference, apps, workflows and agents; semantic retrieval is provided through iFinder and iAssistant.'
        }
      ]
    },
    { type: 'crosssell', exclude: 'api.html' },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
