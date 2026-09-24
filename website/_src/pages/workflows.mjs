export default ({ SITE }) => ({
  file: 'workflows.html',
  title: 'AI Workflow Automation and Agents | iHub Apps',
  description:
    'Build multi-step AI automation with a visual editor: 26 node types, decisions, loops, parallel branches, HTTP and code steps, human approval, schedules and webhooks. Plus autonomous agents with memory and budgets.',
  ogImage: 'workflow-editor.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'For complex automation · Preview',
      title: 'iHub Workflows & Agents',
      lead: 'Build powerful process automation with AI steps, tools and human-in-the-loop approval. Let autonomous agents handle the recurring work, with budgets and an audit trail.',
      ctas: [
        { label: 'Get started', href: SITE.releases, primary: true, icon: 'download' },
        { label: 'Workflow documentation', href: SITE.docsBase + 'workflows.md' }
      ],
      sub: 'Workflows and the Agent Factory are preview features. Enable them under Admin → Features.',
      image: 'workflow-editor.webp',
      alt: 'The visual workflow editor with a node palette on the left and a research workflow on the canvas.'
    },
    {
      type: 'tabs',
      soft: true,
      title: 'Automate anything. Deploy workflows for all departments.',
      lead: '18 workflow templates ship with the platform, from research to audit-grade document review.',
      tabs: [
        {
          label: 'Research',
          image: 'workflow-editor.webp',
          alt: 'Research Assistant workflow in the editor.',
          caption:
            'Research Assistant, Topic Deep Dive, Iterative Research with autonomous or human review.'
        },
        {
          label: 'Knowledge & documents',
          image: 'admin-workflows.webp',
          alt: 'The workflows list in the admin panel.',
          caption:
            'Knowledge Base Q&A, Document Analysis, Corpus Completeness Analysis over iFinder.'
        },
        {
          label: 'Approvals',
          image: 'admin-agent-approvals.webp',
          alt: 'The pending approvals queue for agents.',
          caption: 'Research with Approval: a human checkpoint before results are published.'
        },
        {
          label: 'Run history',
          image: 'admin-workflow-executions.webp',
          alt: 'The workflow executions page.',
          caption: 'Every execution with status, steps, export, restart and cancel.'
        },
        {
          label: 'For users',
          image: 'workflows.webp',
          alt: 'The user-facing workflows page.',
          caption: 'Users start workflows from their own page, from chat with @, or as a chat tool.'
        }
      ]
    },
    {
      type: 'cards',
      title:
        'Build with full flexibility. Choose between agentic or fully deterministic automation.',
      cols: 4,
      items: [
        {
          icon: 'sparkles',
          title: 'AI steps',
          text: 'Prompt, planner and verifier nodes with per-node model and thinking overrides.'
        },
        {
          icon: 'workflow',
          title: 'Flow control',
          text: 'Decision branches (expression, equals, contains, LLM), loops with nesting, parallel and join.'
        },
        {
          icon: 'bolt',
          title: 'Actions',
          text: 'Tool, HTTP request with SSRF guard, sandboxed JavaScript, transform and memory nodes.'
        },
        {
          icon: 'users',
          title: 'Human in the loop',
          text: 'Approval checkpoints and ask-user questions, restricted to approver groups.'
        },
        {
          icon: 'clock',
          title: 'Triggers',
          text: 'Manual, cron schedule with time zone, and HMAC-signed webhooks. Safe on multiple instances.'
        },
        {
          icon: 'layers',
          title: 'Versioning',
          text: 'Draft and published versions, version list, activate any version, export and import.'
        },
        {
          icon: 'eye',
          title: 'Run history',
          text: 'Checkpoints, crash-resume, SSE progress, per-execution export, restart and cancel.'
        },
        {
          icon: 'search',
          title: 'Audit-grade nodes',
          text: 'Query plan, corpus search, structured records, quote validation and templated reports for legal and public-sector reviews.'
        }
      ]
    },
    {
      type: 'features',
      soft: true,
      title: 'Autonomous agents with guard rails.',
      lead: 'The Agent Factory runs profiles that wake up on a schedule, a webhook or on demand, act with a service-account identity and stay inside a budget.',
      items: [
        {
          title: 'Agent profiles',
          badge: 'Preview',
          badgeClass: 'preview',
          text: 'Plan, run tools, verify results adversarially and write artifacts. Each profile has its own tools, skills, model, token budget and tool-round limits.',
          bullets: [
            'Long-term memory in Markdown',
            'Inboxes with TODO checklists',
            'Dynamic task queues with planner and drain'
          ],
          image: 'admin-agent-edit.webp',
          alt: 'The agent profile editor.'
        },
        {
          title: 'Approvals and operator steering',
          text: 'Actions that need a human wait in a pending-approvals queue visible only to approver groups. Operators can steer a run mid-flight and cancel or resume after a crash.',
          image: 'admin-agent-approvals.webp',
          alt: 'The pending approvals page.'
        },
        {
          title: 'Runs, inboxes and memory',
          text: 'Every run is logged step by step. Inboxes hold the work an agent should pick up; memory holds what it learned. Both are editable by admins.',
          image: 'admin-agents.webp',
          alt: 'The agents overview page.'
        }
      ]
    },
    {
      type: 'features',
      title: 'Workflows inside the chat.',
      items: [
        {
          title: 'Mention a workflow with @ or run it as a tool',
          text: 'Users can start a workflow from any chat by typing @, or an app can call a workflow as a tool and pass the result straight through. Progress streams into the conversation.',
          image: 'workflows.webp',
          alt: 'The workflows page for users.'
        }
      ]
    },
    {
      type: 'faq',
      items: [
        {
          q: 'What is the difference between an app, a workflow and an agent?',
          a: 'An app answers interactively in a chat. A workflow orchestrates a fixed sequence of steps with branches, loops and approvals. An agent is an autonomous profile that wakes up on a trigger, plans its own steps within a budget and asks for approval when needed.'
        },
        {
          q: 'Do I need to code?',
          a: 'No. Workflows are built on a visual canvas with a node palette, a variables panel and an edge-condition editor. Code nodes are optional.'
        },
        {
          q: 'How are workflows triggered?',
          a: 'Manually, from chat, on a cron schedule with time zone, or via an HMAC-signed webhook. A cross-process scheduler lock keeps schedules safe when you run several workers or servers.'
        },
        {
          q: 'Who can build and run workflows?',
          a: 'Permissions are per group, like everything else in iHub. Admins enable the preview feature under Admin → Features.'
        },
        {
          q: 'What happens if the server restarts mid-run?',
          a: 'Executions checkpoint after each node and resume automatically on start-up.'
        }
      ]
    },
    { type: 'crosssell', exclude: 'workflows.html' },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
