export default ({ SITE }) => ({
  file: 'apps.html',
  title: 'AI Apps | iHub Apps',
  description:
    'Build and roll out AI assistants for recurring tasks: expert prompts, input forms, knowledge sources, tools and skills, shared per team. 24 apps ship out of the box, 43 more as examples.',
  ogImage: 'admin-app-edit.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'Custom AI for recurring tasks',
      title: 'iHub Apps',
      lead: 'Build apps with expert instructions, knowledge and tools to support recurring tasks, and roll them out to exactly the teams that need them.',
      ctas: [
        { label: 'Get started', href: SITE.releases, primary: true, icon: 'download' },
        { label: 'App configuration guide', href: SITE.docsBase + 'apps.md' }
      ],
      image: 'admin-app-edit.webp',
      alt: 'The app editor with form and JSON views, basic information, localized names and descriptions.'
    },
    {
      type: 'features',
      soft: true,
      title: 'Example use cases. Find ideas in the built-in catalogue.',
      lead: '24 apps ship with every installation, 15 of them enabled by default. 43 more are available as examples and through the marketplace.',
      items: [
        {
          title: 'Chat & assistants',
          text: 'Chat, Web Chat, iHub Support Bot, Website Bot, Idea Coach, iAssistant.',
          bullets: [
            'Communication: Email Composer, Outlook Reply, Social Media, Translator',
            'Research & analysis: File Analyzer, Summarizer, Meeting Briefing, Agenda Generator, NDA Risk Analyzer, Parliamentary Questions Analyzer',
            'Specialized: Diagram Generator, Image Generator, Audio Transcription, Customs Tariff Assistant, iFinder Search'
          ],
          image: 'apps.webp',
          alt: 'The apps catalogue with search, categories and cards.'
        },
        {
          title: 'Marketplace',
          badge: 'Preview',
          badgeClass: 'preview',
          text: 'Install apps, models, prompts, skills and workflows from the official IntraFind registry or your own registry with one click. Export any app as JSON and import it on another installation.',
          image: 'admin-marketplace.webp',
          alt: 'The marketplace page in the admin panel.'
        }
      ]
    },
    {
      type: 'cards',
      title: 'Simple to build. Equip your app with instructions, inputs, knowledge and actions.',
      cols: 4,
      items: [
        {
          icon: 'file',
          title: 'Expert instructions',
          text: 'System prompt per language, greeting, writing style, temperature, output format, starter prompts and global variables such as date, user and locale.'
        },
        {
          icon: 'window',
          title: 'Input forms',
          text: 'Typed variables with dropdowns, predefined values and required fields turn a prompt into a form anyone can fill in.'
        },
        {
          icon: 'layers',
          title: 'Knowledge',
          text: 'Attach sources: files, URLs with content cleaning, internal pages or iFinder queries. Load them into the prompt or let the model fetch on demand.'
        },
        {
          icon: 'bolt',
          title: 'Tools & skills',
          text: 'Web search, Jira, people search, iFinder, OpenAPI operations, MCP servers, other apps and workflows. Skills package reusable procedures.'
        }
      ]
    },
    {
      type: 'features',
      soft: true,
      title: 'Everything an app can do.',
      items: [
        {
          title: 'A form, not a blank page',
          text: 'Required and optional parameters appear next to the chat. Users pick an e-mail type and tone, paste their notes and get a finished draft.',
          image: 'chat-email-composer.webp',
          alt: 'Email Composer with input parameters for type, recipient, subject and tone.'
        },
        {
          title: 'Create apps with the wizard, edit them as a form or as JSON',
          text: 'Describe the app in a sentence and let the AI generate the configuration, or fill in the form. Every field is validated against a schema, and the JSON view shows exactly what is saved.',
          bullets: [
            'Clone, download and upload apps as JSON',
            'Change history with before/after diffs',
            'App inheritance: child apps override a parent'
          ],
          image: 'admin-app-edit.webp',
          alt: 'The app editor with Form and JSON tabs and an “All valid” indicator.'
        },
        {
          title: 'Tools, OpenAPI imports and MCP servers',
          text: 'Enable tools per app. Import any OpenAPI specification and pick the operations the model may call; connect MCP servers with bearer or OAuth authentication. Apps can call other apps and workflows as tools.',
          image: 'admin-tools.webp',
          alt: 'The tools list in the admin panel with script, OpenAPI and MCP tools.'
        },
        {
          title: 'Skills for procedures that repeat',
          badge: 'Preview',
          badgeClass: 'preview',
          text: 'Skills follow the Agent Skills standard (SKILL.md plus references, scripts and assets). Assign them to apps, restrict them per group, and declare which tools a skill may use.',
          image: 'admin-skills.webp',
          alt: 'The skills list in the admin panel.'
        }
      ]
    },
    {
      type: 'features',
      title: 'Collaborate with ease. Share your apps across the organization.',
      items: [
        {
          title: 'Roll out per team',
          text: 'Apps, prompts, models, skills, tools and workflows are permissioned per group. Groups inherit from each other and map to LDAP, OIDC or proxy groups, so “Employees” from your directory simply works.',
          bullets: [
            'Content admins manage only their own groups',
            'Anonymous, authenticated and admin defaults',
            'Enable or disable any app with one switch'
          ],
          image: 'admin-groups.webp',
          alt: 'The groups page with permissions and external mappings.'
        },
        {
          title: 'Bring apps anywhere',
          text: 'Use apps inside Outlook, from the browser side panel on any web page, inside Nextcloud Files, as a Microsoft Teams tab, through the OpenAI-compatible API or as tools in Claude, Cursor and VS Code via the MCP gateway.',
          image: 'admin-office.webp',
          alt: 'Admin settings for the Outlook add-in.',
          link: { label: 'See all integrations', href: 'integrations.html' }
        },
        {
          title: 'Short links with prefilled parameters',
          text: 'Share a link that opens a specific app with variables already filled in, optionally with an expiry date. Ideal for intranet buttons and process documentation.',
          image: 'chat-share-modal.webp',
          alt: 'The share dialog generating a short link for an app.'
        }
      ]
    },
    {
      type: 'faq',
      items: [
        {
          q: 'What is an app?',
          a: 'A standardized use case with a fixed frame: system prompt, input variables, output format, preferred and allowed models, plus the tools, sources and skills it may use. Users get reproducible results without knowing anything about prompting.'
        },
        {
          q: 'How is an app different from the general chat or a prompt template?',
          a: 'Chat is fully free-form. A prompt template is text a user inserts and edits. An app fixes the frame and can be rolled out per group. Skills sit in between: reusable multi-step procedures that several apps share.'
        },
        {
          q: 'Can I create an app without coding?',
          a: 'Yes. The admin UI has a creation wizard with AI generation and a full form editor. JSON is available for power users and for moving apps between installations.'
        },
        {
          q: 'Can apps produce structured data?',
          a: 'Yes. Define a JSON schema as output and, optionally, a custom React renderer that displays the result as a table, checklist or chart.'
        },
        {
          q: 'Where do apps run?',
          a: 'On your iHub server. The model can be a cloud API, an IntraFind-hosted GPU in a German data centre, or your own local endpoint.'
        }
      ]
    },
    { type: 'crosssell', exclude: 'apps.html' },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
