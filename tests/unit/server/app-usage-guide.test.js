import { describe, expect, it } from '@jest/globals';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import {
  buildUsageGuideMessages,
  describeAppForGuide,
  selectGuideModel,
  unwrapFence,
  withoutUsageGuideContent
} from '../../../server/utils/appUsageGuide.js';

/**
 * Usage guide (issue #2838): pre-written "how to use this app" text kept in the
 * app itself, shown in the chat without a model call.
 */

const app = {
  id: 'email',
  name: { en: 'Email', de: 'E-Mail' },
  description: { en: 'Drafts emails', de: 'Entwirft E-Mails' },
  color: '#4F46E5',
  icon: 'mail',
  system: { en: 'You are a secret email assistant.' },
  variables: [
    {
      name: 'tone',
      label: { en: 'Tone' },
      type: 'select',
      required: true,
      predefinedValues: [{ value: 'formal', label: { en: 'Formal' } }]
    }
  ],
  starterPrompts: [{ title: { en: 'Reply' }, message: { en: 'Reply to this mail' } }],
  upload: { enabled: true, fileUpload: { enabled: true } },
  usageGuide: {
    question: { en: 'How does this work?' },
    content: { en: '## Usage\n\nPaste a mail.', de: '## Nutzung\n\nMail einfügen.' }
  }
};

describe('app usageGuide schema', () => {
  it('is kept on load', () => {
    const result = appConfigSchema.safeParse(app);

    expect(result.success).toBe(true);
    expect(result.data.usageGuide).toEqual(app.usageGuide);
  });

  it('needs the guide text, and the question is optional', () => {
    const { question: _question, ...contentOnly } = app.usageGuide;

    expect(appConfigSchema.safeParse({ ...app, usageGuide: contentOnly }).success).toBe(true);
    expect(appConfigSchema.safeParse({ ...app, usageGuide: { question: {} } }).success).toBe(false);
    expect(appConfigSchema.safeParse({ ...app, usageGuide: { content: { en: '' } } }).success).toBe(
      false
    );
  });

  it('is absent from apps that do not set it', () => {
    const { usageGuide: _usageGuide, ...withoutGuide } = app;

    expect(appConfigSchema.parse(withoutGuide).usageGuide).toBeUndefined();
  });
});

describe('withoutUsageGuideContent', () => {
  it('drops the guide text from the app list but keeps the question', () => {
    const plain = { id: 'plain' };
    const [listed, untouched] = withoutUsageGuideContent([app, plain]);

    expect(listed.usageGuide).toEqual({ question: app.usageGuide.question });
    expect(untouched).toBe(plain);
  });

  it('leaves the cached app object alone', () => {
    withoutUsageGuideContent([app]);

    expect(app.usageGuide.content.en).toContain('Paste a mail');
  });
});

describe('usage guide generation prompt', () => {
  it('describes what the user can do with the app in the requested language', () => {
    const description = describeAppForGuide(app, 'de');

    expect(description).toContain('Name: E-Mail');
    expect(description).toContain('Tone (select; required; choices: Formal)');
    expect(description).toContain('- Reply: Reply to this mail');
    expect(description).toContain('documents');
  });

  it('names the knowledge only while the app uses projects', () => {
    const linked = { ...app, projects: ['faq'] };
    const catalog = { projects: [{ id: 'faq', name: { en: 'FAQ' } }] };

    expect(describeAppForGuide(linked, 'en', catalog)).toContain(
      'Knowledge the assistant answers from: FAQ'
    );
    const off = { ...linked, features: { ...linked.features, projects: false } };
    expect(describeAppForGuide(off, 'en', catalog)).not.toContain('Knowledge the assistant');
  });

  it('asks for the guide in the language, without quoting the instructions', () => {
    const [system, user] = buildUsageGuideMessages(app, 'de');

    expect(system.content).toContain('in German');
    expect(system.content).toMatch(/never quote/i);
    expect(user.content).toContain('You are a secret email assistant.');
  });
});

describe('unwrapFence', () => {
  it('strips a markdown fence around the whole answer', () => {
    expect(unwrapFence('```markdown\n## Usage\n\nPaste a mail.\n```')).toBe(
      '## Usage\n\nPaste a mail.'
    );
    expect(unwrapFence('  ```\nText\n```  ')).toBe('Text');
    expect(unwrapFence('```MD\nText\n```')).toBe('Text');
  });

  it('leaves answers without a wrapping markdown fence alone', () => {
    expect(unwrapFence('## Usage\n\n```js\ncode\n```\n\nMore.')).toBe(
      '## Usage\n\n```js\ncode\n```\n\nMore.'
    );
    expect(unwrapFence('```js\ncode\n```')).toBe('```js\ncode\n```');
    expect(unwrapFence('```markdown\nnot closed')).toBe('```markdown\nnot closed');
    expect(unwrapFence()).toBe('');
  });

  it('stays fast on long input', () => {
    const long = `\`\`\`\n${'\n'.repeat(50000)}x`;
    const started = Date.now();
    unwrapFence(long);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('selectGuideModel', () => {
  const models = [
    { id: 'image', modelType: 'chat', supportsImageGeneration: true, default: true },
    { id: 'conversation', provider: 'iassistant-conversation' },
    { id: 'speech', modelType: 'transcription' },
    { id: 'chat-a' },
    { id: 'chat-b', default: true }
  ];
  const all = () => true;

  it('takes the default chat model', () => {
    expect(selectGuideModel(models, all).id).toBe('chat-b');
  });

  it('only takes models the admin may use', () => {
    expect(selectGuideModel(models, model => model.id !== 'chat-b').id).toBe('chat-a');
    expect(selectGuideModel(models, () => false)).toBeUndefined();
  });

  it('never takes image, transcription or conversation-backed models', () => {
    const others = models.filter(model => !model.id.startsWith('chat-'));
    expect(selectGuideModel(others, all)).toBeUndefined();
  });
});
