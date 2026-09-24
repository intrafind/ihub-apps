export default ({ SITE }) => ({
  file: 'security.html',
  title: 'Security & Privacy | iHub Apps',
  description:
    'Your infrastructure, your identity provider, your models. Multi-mode authentication, hierarchical groups, encryption at rest, audit log, PII handling, rate limiting and OpenTelemetry, all in a self-hosted open-source package.',
  ogImage: 'admin-auth.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'Security & privacy',
      title: 'Your data, your rules, your servers.',
      lead: 'iHub Apps runs where you decide, authenticates against the directory you already have, and writes an audit trail for everything. Data sovereignty is not a tier, it is the default.',
      ctas: [
        {
          label: 'Security guide',
          href: SITE.docsBase + 'security.md',
          primary: true,
          icon: 'shield'
        },
        {
          label: 'Authentication architecture',
          href: SITE.docsBase + 'authentication-architecture.md'
        }
      ],
      image: 'admin-auth.webp',
      alt: 'The authentication settings page with local, OIDC, LDAP, NTLM and proxy providers.'
    },
    {
      type: 'cards',
      soft: true,
      title: 'Deployment options.',
      lead: 'The same package for a laptop and for a regulated data centre.',
      cols: 4,
      items: [
        {
          icon: 'terminal',
          title: 'Single binary',
          text: 'Linux, macOS, Windows. No Node.js, no Docker, no database. Base64 variants for restricted networks.'
        },
        {
          icon: 'server',
          title: 'Docker & Kubernetes',
          text: 'Official image on GitHub Container Registry, compose files and an nginx example. Multi-worker and multi-server ready.'
        },
        {
          icon: 'building',
          title: 'On-premise & air-gapped',
          text: 'Run with local models and no outbound traffic. Outbound proxy support and SSL allowlists for corporate networks.'
        },
        {
          icon: 'globe',
          title: 'IntraFind hosting',
          text: 'Managed operation and GPU inference in German data centres with tenant separation and IP allowlisting.'
        }
      ]
    },
    {
      type: 'features',
      title: 'Identity and access.',
      items: [
        {
          title: 'Every login mode your organization uses',
          text: 'Anonymous, local accounts, OpenID Connect with several providers at once, ADFS, LDAP with group lookup, NTLM / Windows integrated, proxy headers and pure JWT providers, Microsoft Teams single sign-on. Modes combine.',
          bullets: [
            'Login test for LDAP and OIDC in the admin UI',
            'Auto-redirect to a single provider',
            'Session timeout and secure cookie settings'
          ],
          image: 'admin-auth.webp',
          alt: 'Authentication configuration page.'
        },
        {
          title: 'Hierarchical groups with external mappings',
          text: 'Groups inherit from each other (admin → users → authenticated → anonymous) and map to directory groups. Permissions cover apps, prompts, models, skills, tools and workflows. Content admins manage only their own groups.',
          image: 'admin-group-edit.webp',
          alt: 'The group editor with permissions and mappings.'
        },
        {
          title: 'iHub as identity provider and OAuth server',
          text: 'Built-in OAuth 2.0 authorization server with client credentials, authorization code + PKCE, refresh tokens, consent, introspection, revocation and dynamic client registration. OIDC discovery, JWKS and userinfo for your other apps.',
          image: 'admin-oauth-server.webp',
          alt: 'OAuth authorization server settings.'
        },
        {
          title: 'Users and personal keys',
          text: 'Local user management with activity view, connected apps and personal API keys that act as the user and never carry admin rights.',
          image: 'admin-users.webp',
          alt: 'The users list in the admin panel.'
        }
      ]
    },
    {
      type: 'features',
      soft: true,
      title: 'Protection and evidence.',
      items: [
        {
          title: 'Secrets encrypted at rest',
          text: 'API keys, OAuth tokens and platform secrets are AES-256-GCM encrypted with a key kept outside the configuration. A value-encryption tool encrypts anything else you paste into a config file.',
          bullets: [
            'SSL certificate upload, CORS and cookie settings',
            'SSRF allowlist and outbound proxy',
            'Rate limiting in six categories, request concurrency limits'
          ],
          image: 'admin-security.webp',
          alt: 'The security settings page.'
        },
        {
          title: 'Audit log with retention',
          text: 'Admin actions, authentication events and configuration changes are written to an append-only JSONL log with filters kept in the URL, retention settings and a mirror to your logging stack.',
          image: 'admin-audit-log.webp',
          alt: 'The audit log page with filters.'
        },
        {
          title: 'OpenTelemetry with GenAI conventions',
          text: 'Spans, metrics, events and logs for every model call, tool call and workflow step. OTLP, Prometheus or console exporters. Prompts and completions are captured only if an admin opts in.',
          image: 'admin-telemetry.webp',
          alt: 'The telemetry settings page.'
        },
        {
          title: 'Usage reports without personal data',
          text: 'Tokens by app, model and user, magic-prompt statistics, timeline and CSV/JSON export. A pseudonymous tracking mode keeps individuals out of the reports.',
          image: 'admin-usage.webp',
          alt: 'The usage reports page with charts.'
        }
      ]
    },
    {
      type: 'cards',
      title: 'Privacy by design.',
      cols: 3,
      items: [
        {
          icon: 'eye',
          title: 'Nothing stored by default',
          text: 'Conversations live in the browser session unless Durable Chats is enabled. Ephemeral apps never store anything. Incognito mode per chat.'
        },
        {
          icon: 'clock',
          title: 'Retention you control',
          text: 'Audit events, usage events, feedback and chats each have their own retention. IP addresses are anonymized and e-mail addresses masked in logs.'
        },
        {
          icon: 'file',
          title: 'GDPR data-subject requests',
          text: 'A documented procedure covers access, export and deletion requests, and the data model tells you exactly where personal data can appear.',
          href: SITE.docsBase + 'pii-data-handling.md',
          more: 'PII handling guide'
        },
        {
          icon: 'lock',
          title: 'Local models for sensitive work',
          text: 'Route sensitive apps to a local or IntraFind-hosted model and public scenarios to a cloud model. Model hints warn users about data classification.'
        },
        {
          icon: 'users',
          title: 'Accessibility',
          text: 'Targets WCAG 2.2 AA, EN 301 549 and BITV 2.0; automated axe checks run in CI.'
        },
        {
          icon: 'github',
          title: 'Open source',
          text: 'Every line of code is public under a BSD-3-Clause licence with attribution. Audit it, fork it, or ask IntraFind to certify a deployment with you.'
        }
      ]
    },
    {
      type: 'faq',
      items: [
        {
          q: 'Is iHub Apps certified (ISO 27001, SOC 2)?',
          a: 'iHub Apps is software you run inside your own certified environment; the software itself carries no certificate. IntraFind supports customers with security documentation and hardening guides, and offers managed hosting on request.'
        },
        {
          q: 'Does any data go to IntraFind?',
          a: 'No. There is no telemetry to IntraFind. Updates are downloaded from GitHub releases only when an admin triggers them.'
        },
        {
          q: 'Does the model provider train on our data?',
          a: 'That depends on the provider and contract you choose. With local models or IntraFind-hosted GPUs, no data leaves your control.'
        },
        {
          q: 'Which authentication should we use?',
          a: 'Corporate SSO via OIDC (Microsoft Entra, Google, Keycloak, Okta, ADFS) is the recommended default. LDAP, NTLM and proxy authentication cover on-premise Windows environments.'
        },
        {
          q: 'Can we run it fully offline?',
          a: 'Yes. Use the binary, a local model server and the Base64 download variant for restricted networks. Documentation is served from the product.'
        }
      ]
    },
    {
      type: 'cta',
      title: 'Bring iHub into your security review.',
      text: 'Download the binary, read the security guide, and run it next to your identity provider. Every setting is documented and every change is audited.'
    },
    { type: 'trust' }
  ]
});
