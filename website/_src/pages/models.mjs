export default ({ SITE }) => ({
  file: 'models.html',
  title: 'AI Models | iHub Apps',
  description:
    'Use every major model inside chat, apps, workflows and the API: OpenAI, Anthropic, Google, Mistral, AWS Bedrock, Azure OpenAI and local OpenAI-compatible servers such as vLLM, LM Studio and Ollama.',
  ogImage: 'admin-models.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'Model agnostic',
      title: 'All models in one place.',
      lead: 'Use any model inside chat, apps, workflows and agents or via the API. Bring your own keys, host your own models, and decide per group who may use what.',
      ctas: [
        {
          label: 'Model configuration guide',
          href: SITE.docsBase + 'models.md',
          primary: true,
          icon: 'cpu'
        },
        { label: 'Local LLM providers', href: SITE.docsBase + 'local-llm-providers.md' }
      ],
      image: 'admin-models.webp',
      alt: 'The models list in the admin panel with provider, status and capability columns.'
    },
    {
      type: 'table',
      soft: true,
      title: 'Providers',
      lead: 'Eight adapters cover the cloud providers and everything that speaks the OpenAI protocol.',
      columns: ['Provider', 'Models', 'Notes'],
      rows: [
        [
          'OpenAI',
          'GPT-5 family via the Responses API, GPT-4 class via Chat Completions',
          'Native web search, audio input, tool calling'
        ],
        [
          'Anthropic',
          'Claude Fable 5.1, Opus 5, Sonnet 5, Haiku 4.5',
          'Thinking levels, native web search'
        ],
        [
          'Google',
          'Gemini 3.x Pro and Flash, Flash Lite, image models, transcription',
          'Grounding, vision, audio, image generation'
        ],
        [
          'Mistral',
          'Mistral Large, Medium, Small; Voxtral realtime',
          'Realtime voice transcription via vLLM'
        ],
        [
          'AWS Bedrock',
          'Claude, Nova, Llama 3.3 and 4, Mistral, Pixtral, Cohere Command R, Jamba, DeepSeek',
          'Converse API, regional and global inference profiles'
        ],
        ['Azure OpenAI', 'Your Azure deployments', 'OpenAI adapter with custom URL'],
        [
          'Local / OpenAI-compatible',
          'vLLM, LM Studio, Jan.ai, Ollama, llama.cpp, any gateway',
          'Auto-discovery via <code>/v1/models</code>, schema sanitizing, reasoning parser'
        ],
        [
          'IntraFind',
          'iAssistant conversation (grounded RAG), IntraFind-hosted GPUs',
          'Enterprise search as a model; German data centres'
        ]
      ],
      note: 'Model files are plain JSON. Add a new model by dropping a file into the content folder or through the admin UI; no restart required.'
    },
    {
      type: 'features',
      title: 'Control what users may choose.',
      items: [
        {
          title: 'Per app, per group, per chat',
          text: 'An app can start with a preferred model, restrict the selectable models or hide the selector entirely. Groups restrict which models their members may use at all. Users switch models mid-conversation when allowed.',
          bullets: [
            'Context window and output limits per model',
            'Capability flags: tools, vision, audio, image generation',
            'Model hints: information or warning banners for data classification'
          ],
          image: 'chat-model-selector.webp',
          alt: 'The model selector in the chat listing allowed models.'
        },
        {
          title: 'Bring your own keys, encrypted',
          text: 'API keys are stored AES-256-GCM encrypted per provider or per model. Test a model with one click, clone it, and auto-discover what a local server currently has loaded.',
          image: 'admin-model-edit.webp',
          alt: 'The model editor with URL, provider, limits and capability settings.'
        },
        {
          title: 'Providers as building blocks',
          text: 'Providers hold the technical connection: endpoint and credentials. They also cover web search (Brave, Staan, Qwant) and IntraFind services, so one page shows every external dependency.',
          image: 'admin-providers.webp',
          alt: 'The providers page listing LLM and web-search providers.'
        },
        {
          title: 'Compare before you commit',
          badge: 'Preview',
          badgeClass: 'preview',
          text: 'Compare mode sends one prompt to two models. Evaluate a cheaper model, a European provider or a local deployment against your current default with real prompts.',
          image: 'chat-compare.webp',
          alt: 'Two models answering the same prompt side by side.'
        }
      ]
    },
    {
      type: 'cards',
      soft: true,
      title: 'Three ways to run models.',
      cols: 3,
      items: [
        {
          icon: 'globe',
          title: 'Cloud APIs',
          text: 'Use your own accounts with OpenAI, Anthropic, Google, Mistral, AWS or Azure. iHub adds the permission layer, the audit trail and the apps.'
        },
        {
          icon: 'server',
          title: 'IntraFind-hosted GPUs',
          text: 'Dedicated GPUs in German data centres, tenant-separated, end-to-end encrypted, IP allowlisting and no training on your data.'
        },
        {
          icon: 'lock',
          title: 'Your own hardware',
          text: 'Point iHub at vLLM, LM Studio, Jan.ai or Ollama for fully air-gapped operation. Auto-discovery picks up whatever model is loaded.'
        }
      ]
    },
    {
      type: 'faq',
      items: [
        {
          q: 'When are new models available?',
          a: 'As soon as you add them. A model is a JSON file with URL, provider, limits and capability flags; the admin UI edits it live. Releases add new default models regularly, see the changelog.'
        },
        {
          q: 'Can I mix providers in one app?',
          a: 'Yes. An app can allow several models from different providers; a workflow can use a different model per node.'
        },
        {
          q: 'Is there a model router?',
          a: 'Not built in. Apps set a preferred model and allowed alternatives; users or admins choose. Compare mode helps evaluate candidates.'
        },
        {
          q: 'Does iHub support image generation and voice?',
          a: 'Image generation and editing through Gemini image models; voice input through the browser, Azure Speech or a self-hosted realtime model such as Voxtral on vLLM.'
        }
      ]
    },
    { type: 'crosssell', exclude: 'models.html' },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
