export default ({ SITE }) => ({
  file: 'chat.html',
  title: 'AI Chat for Teams | iHub Apps',
  description:
    'Model-agnostic, intuitive AI chat for everyday use by the whole organization: files, voice, web search with citations, diagrams, compare mode, canvas and chat history. Self-hosted.',
  ogImage: 'chat-answer.webp',
  sections: [
    {
      type: 'hero',
      eyebrow: 'For daily work',
      title: 'iHub Chat',
      lead: 'Model-agnostic, intuitive AI chat for everyday use by the whole organization. Every conversation stays inside your infrastructure.',
      ctas: [
        { label: 'Get started', href: SITE.releases, primary: true, icon: 'download' },
        { label: 'Talk to IntraFind', href: SITE.contact }
      ],
      image: 'chat-answer.webp',
      alt: 'The iHub chat with a streamed Markdown answer, app sidebar, model selector and context-window indicator.'
    },
    {
      type: 'tabs',
      soft: true,
      title: 'Everyday AI. Use cases for every department.',
      lead: 'The general chat is one app among many. Each department gets apps with the right prompt, inputs and knowledge built in.',
      tabs: [
        {
          label: 'Communication',
          image: 'chat-email-composer.webp',
          alt: 'The Email Composer app with type, recipient, subject and tone parameters.',
          caption: 'Email Composer: pick type, recipient and tone; the app writes the draft.'
        },
        {
          label: 'Research',
          image: 'chat-research.webp',
          alt: 'Web Chat app answering a research question with headings and cited sources.',
          caption: 'Web Chat: live web search with cited sources in the answer.'
        },
        {
          label: 'Legal',
          image: 'app-nda-empty.webp',
          alt: 'The NDA Risk Analyzer app waiting for a contract upload.',
          caption: 'NDA Risk Analyzer: structured risk output rendered by a custom component.'
        },
        {
          label: 'Operations',
          image: 'chat-mermaid.webp',
          alt: 'The Diagram Generator app rendering a process flowchart.',
          caption: 'Diagram Generator: process descriptions become Mermaid diagrams.'
        },
        {
          label: 'Files',
          image: 'app-file-analysis-empty.webp',
          alt: 'The File Analyzer app with upload controls.',
          caption:
            'File Analyzer: PDF, Office, e-mail, audio and video files, parsed in the browser.'
        },
        {
          label: 'Meetings',
          image: 'mobile-home.webp',
          alt: 'The iHub start page on a phone with a greeting, quick chat input and recent apps.',
          caption: 'Meeting Briefing and Agenda Generator work on the phone as well.'
        }
      ]
    },
    {
      type: 'bento',
      title: 'One interface. Every capability.',
      items: [
        {
          title: 'Model agnostic',
          text: 'Work with GPT, Claude, Gemini, Mistral, Bedrock or a local model in one interface. Switch mid-conversation; admins decide which groups may use which models.',
          image: 'chat-model-selector.webp',
          alt: 'The model selector dropdown listing Claude, Gemini, GPT-5 and Mistral models.'
        },
        {
          title: 'Company knowledge',
          text: 'Ground answers in your own content: local files, web pages, internal pages and iFinder enterprise search with the user’s own permissions.',
          image: 'admin-sources.webp',
          alt: 'Admin list of knowledge sources with type, exposure and status columns.'
        },
        {
          title: 'Work with files',
          text: 'Upload documents, presentations, spreadsheets, e-mails, images, audio and video, or pick them from Google Drive, OneDrive, SharePoint and Nextcloud.',
          image: 'app-file-analysis-empty.webp',
          alt: 'File upload controls in the File Analyzer app.'
        },
        {
          title: 'Image generation',
          text: 'Generate and edit images with Gemini image models, including aspect ratio and quality controls and multi-turn editing.',
          image: 'app-image-generator-empty.webp',
          alt: 'The Image Generator app with starter prompts and generation controls.'
        }
      ]
    },
    {
      type: 'features',
      soft: true,
      title: 'Always grounded in facts.',
      lead: 'Rely on citations for fact-based answers.',
      items: [
        {
          title: 'Web search with sources',
          text: 'Native search grounding from Google, OpenAI and Anthropic, or server-side search via Brave, Staan (EU index) and Qwant. The answer shows which queries ran and where each fact came from.',
          bullets: [
            'Answer source badge: model, web, sources, grounding or mixed',
            'Citation panel with document preview and highlighted passages',
            'Search follows the user’s language'
          ],
          image: 'chat-research.webp',
          alt: 'Research answer with headings, numbered findings and a Sources section.'
        },
        {
          title: 'Compare two models on the same prompt',
          badge: 'Preview',
          badgeClass: 'preview',
          text: 'Send one message to two models and read both answers side by side. Perfect for evaluating a new model or a local alternative before you standardize.',
          image: 'chat-compare.webp',
          alt: 'Compare mode with two model panels answering the same prompt.'
        },
        {
          title: 'Ask for clarification instead of guessing',
          text: 'Apps can pause and ask the user a question with chips, dropdowns or free text before they continue. Tool activity shows what each call asked for and why it failed.',
          image: 'chat-empty.webp',
          alt: 'Empty chat with greeting, input box, magic prompt and microphone buttons.'
        }
      ]
    },
    {
      type: 'features',
      title: 'Real-time voice for work.',
      lead: 'Dictate instead of typing, on the desktop and on the phone.',
      items: [
        {
          title: 'Voice input with review',
          text: 'Speak into any app. Transcription runs in the browser, through Azure Speech (including on-prem containers) or through a self-hosted realtime model such as Voxtral on vLLM, relayed by the iHub server.',
          bullets: [
            'Automatic or manual mode with a transcript overlay',
            'Record-then-transcribe for files and video',
            'Dictation app with AI clean-up'
          ],
          image: 'mobile-chat.webp',
          alt: 'The iHub chat on a phone with a streamed answer.',
          browser: false
        }
      ]
    },
    {
      type: 'features',
      soft: true,
      title: 'Redefining your output.',
      lead: 'Go from chat interactions to structured documents.',
      items: [
        {
          title: 'Canvas',
          text: 'Open a document editor next to the chat. Continue, summarize, expand, translate or change the tone of any passage, and insert answers straight into the document.',
          image: 'canvas.webp',
          alt: 'Canvas mode with the chat on the left and a rich-text document editor on the right.'
        },
        {
          title: 'Structured output and custom renderers',
          text: 'Apps can require a JSON schema and render the result with a custom React component: risk tables, extracted questions, checklists. No rebuild needed, renderers live in the content folder.',
          image: 'app-nda-empty.webp',
          alt: 'The NDA Risk Analyzer app, which renders structured results with a custom component.'
        },
        {
          title: 'Diagrams, exports and sharing',
          text: 'Mermaid diagrams render inline with SVG, PNG and PDF export. Whole conversations export to PDF (three templates), DOCX, PPTX, XLSX, Markdown, HTML or JSON. Short links open an app with prefilled parameters.',
          image: 'chat-share-modal.webp',
          alt: 'Share dialog for an app with a generated short link.'
        },
        {
          title: 'Chat history that survives a closed tab',
          badge: 'Preview',
          badgeClass: 'preview',
          text: 'Durable Chats store conversations server-side with retention limits. A long-running answer completes while you are away; rename, reopen and continue from the history page. Incognito mode never stores anything.',
          image: 'chats-history.webp',
          alt: 'The chat history page grouped by Today and Yesterday.'
        }
      ]
    },
    {
      type: 'features',
      title: 'Prompt library and magic prompt.',
      items: [
        {
          title: 'Reusable prompts for the whole team',
          text: 'A searchable, categorized library of prompt templates with variables, scoped to an app or shared globally. Magic Prompt rewrites a rough input into a precise prompt with one click, with undo.',
          image: 'prompts.webp',
          alt: 'The prompt library with categories and template cards.'
        }
      ]
    },
    {
      type: 'faq',
      items: [
        {
          q: 'Where is my data processed?',
          a: 'Inside your iHub deployment and at the model provider you configured. With a local model (vLLM, LM Studio, Ollama) or IntraFind-hosted GPUs in German data centres, nothing leaves your infrastructure.'
        },
        {
          q: 'Are prompts stored?',
          a: 'By default a conversation lives only in the browser session. Admins can enable Durable Chats with retention limits, and any app can be marked ephemeral so nothing is stored at all.'
        },
        {
          q: 'Which models can I use?',
          a: 'OpenAI, Anthropic, Google, Mistral, AWS Bedrock, Azure OpenAI and any OpenAI-compatible endpoint. See the <a href="models.html">models page</a>.'
        },
        {
          q: 'Which file types are supported?',
          a: 'PDF, DOCX, XLSX, PPTX, legacy Office, ODT/ODS/ODP, EML and MSG e-mails, CSV, JSON, HTML, Markdown, VTT transcripts, images (JPG, PNG, GIF, WebP, TIFF), audio (MP3, WAV, FLAC, OGG, M4A) and video with audio extraction.'
        },
        {
          q: 'Does chat work on mobile?',
          a: 'Yes. The interface is responsive and installable as a progressive web app, with voice input and dark mode.'
        }
      ]
    },
    { type: 'crosssell', exclude: 'chat.html' },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
