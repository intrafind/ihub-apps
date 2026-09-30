/**
 * EU AI Act Art. 50 transparency in the chat (issues #2564, #2565):
 * - the pure rules in client/src/features/chat/utils/aiTransparency.js
 * - the first-turn notice, the "AI generated" chip with its second layer,
 *   the periodic reminders of sensitive apps and the stored-message
 *   provenance passthrough.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';
import {
  describeImageMarkings,
  describeTextMarking,
  findImageProvenance,
  getInteractionDisclosure,
  getProviderLegalEntity,
  getReminderMessageIds,
  getReminderSettings,
  isAiLabelShownByDefault,
  isMessageBadgeEnabled
} from '../../../client/src/features/chat/utils/aiTransparency';

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) {
        if (typeof v === 'string' || typeof v === 'number') {
          str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
    }
    return str;
  };
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) };
});

let mockPlatformConfig = null;
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
}));

jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));

jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/integrations/IntegrationAuthPrompts', () => ({
  __esModule: true,
  default: () => null
}));

// The list renders real messages; only the reminder rhythm matters here.
jest.mock('../../../client/src/features/chat/components/ChatMessage', () => ({
  __esModule: true,
  default: ({ message }) => <div data-testid="message">{message.content}</div>
}));

// Imported after the mocks.
const AIInteractionNotice =
  require('../../../client/src/features/chat/components/AIInteractionNotice').default;
const AIProvenanceChip =
  require('../../../client/src/features/chat/components/AIProvenanceChip').default;
const ChatMessageList =
  require('../../../client/src/features/chat/components/ChatMessageList').default;
const {
  transformStoredMessage
} = require('../../../client/src/features/chat/hooks/useChatMessages');

const CONFIG = {
  enabled: true,
  interactionDisclosure: {
    enabled: true,
    firstTurnNotice: true,
    persistentBadge: true,
    reminderInterval: 2
  },
  labels: { messageBadge: true, outbound: true },
  text: { watermarkMinTokens: 200 },
  provider: { legalEntity: '' }
};

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  mockPlatformConfig = { aiTransparency: CONFIG };
});

describe('getInteractionDisclosure', () => {
  test('on when the platform has it on and the app is not opted out', () => {
    expect(getInteractionDisclosure(CONFIG, { aiTransparency: { disclosure: true } })).toEqual({
      active: true,
      firstTurnNotice: true,
      persistentBadge: true
    });
    // an app without the effective view (older server) is not opted out
    expect(getInteractionDisclosure(CONFIG, {}).active).toBe(true);
  });

  test('off for an opted-out app, a platform switch-off and a missing config', () => {
    const off = { active: false, firstTurnNotice: false, persistentBadge: false };
    expect(getInteractionDisclosure(CONFIG, { aiTransparency: { disclosure: false } })).toEqual(
      off
    );
    expect(
      getInteractionDisclosure(
        { ...CONFIG, interactionDisclosure: { ...CONFIG.interactionDisclosure, enabled: false } },
        {}
      )
    ).toEqual(off);
    expect(getInteractionDisclosure(undefined, {})).toEqual(off);
  });

  test('first-turn notice and badge follow their own switches', () => {
    const cfg = {
      interactionDisclosure: { enabled: true, firstTurnNotice: false, persistentBadge: true }
    };
    expect(getInteractionDisclosure(cfg, {})).toEqual({
      active: true,
      firstTurnNotice: false,
      persistentBadge: true
    });
  });
});

describe('labels and provider', () => {
  test('message badge only when the platform says so', () => {
    expect(isMessageBadgeEnabled(CONFIG)).toBe(true);
    expect(isMessageBadgeEnabled({ labels: { messageBadge: false } })).toBe(false);
    expect(isMessageBadgeEnabled(null)).toBe(false);
  });

  test('the shared-chat label is fail-safe: shown unless the feature is off', () => {
    expect(isAiLabelShownByDefault(null)).toBe(true);
    expect(isAiLabelShownByDefault(CONFIG)).toBe(true);
    expect(isAiLabelShownByDefault({ enabled: false })).toBe(false);
  });

  test('provider legal entity is trimmed', () => {
    expect(getProviderLegalEntity({ provider: { legalEntity: '  ACME GmbH ' } })).toBe('ACME GmbH');
    expect(getProviderLegalEntity({})).toBe('');
  });
});

describe('periodic reminders', () => {
  const sensitiveApp = (extra = {}) => ({
    aiTransparency: { disclosure: true, sensitive: 'health', ...extra }
  });

  test('settings: app interval over the platform default, 0 disables', () => {
    expect(getReminderSettings(CONFIG, sensitiveApp())).toEqual({
      category: 'health',
      interval: 2
    });
    expect(getReminderSettings(CONFIG, sensitiveApp({ reminderInterval: 3 }))).toEqual({
      category: 'health',
      interval: 3
    });
    expect(getReminderSettings(CONFIG, sensitiveApp({ reminderInterval: 0 }))).toBeNull();
  });

  test('no reminders for non-sensitive, unknown-category or opted-out apps', () => {
    expect(getReminderSettings(CONFIG, { aiTransparency: { disclosure: true } })).toBeNull();
    expect(getReminderSettings(CONFIG, sensitiveApp({ sensitive: 'sports' }))).toBeNull();
    expect(getReminderSettings(CONFIG, sensitiveApp({ disclosure: false }))).toBeNull();
  });

  test('every Nth finished answer; errors, greetings and streaming answers handled', () => {
    const messages = [
      { id: 'g', role: 'assistant', isGreeting: true },
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'e1', role: 'assistant', error: true },
      { id: 'a2', role: 'assistant' },
      { id: 'a3', role: 'assistant' },
      { id: 'a4', role: 'assistant', loading: true }
    ];
    expect([...getReminderMessageIds(messages, 2)]).toEqual(['a2']);
    expect([...getReminderMessageIds(messages, 1)]).toEqual(['a1', 'a2', 'a3']);
    expect(getReminderMessageIds(messages, 0).size).toBe(0);
  });

  test('ChatMessageList renders the reminder below every Nth answer only', () => {
    const messages = ['a1', 'a2', 'a3', 'a4'].flatMap((id, i) => [
      { id: `u${i}`, role: 'user', content: `question ${i}` },
      { id, role: 'assistant', content: `answer ${i}` }
    ]);
    render(<ChatMessageList messages={messages} app={sensitiveApp()} />);
    const reminders = screen.getAllByRole('note');
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toHaveTextContent(
      'Reminder: you are talking to an AI system, not a person. For health matters, check important information with a qualified person.'
    );
  });
});

describe('marking descriptions', () => {
  test('text marking statuses', () => {
    expect(
      describeTextMarking({ marking: { status: 'marked', technique: 'vllm-gumbel' } }).status
    ).toBe('marked-vllm');
    expect(
      describeTextMarking({ marking: { status: 'marked', technique: 'upstream:google' } })
    ).toEqual({ status: 'marked-upstream', vendor: 'google', tokens: null, reason: null });
    expect(
      describeTextMarking({
        marking: { status: 'unmarked', tokens: 420, reason: 'model-unmarked' }
      })
    ).toEqual({ status: 'unmarked', vendor: null, tokens: 420, reason: 'model-unmarked' });
    expect(describeTextMarking({ marking: { status: 'not-required' } }).status).toBe(
      'not-required'
    );
    expect(describeTextMarking({ marking: { status: 'exempt' } }).status).toBe('exempt');
    expect(describeTextMarking(null).status).toBe('unknown');
  });

  test('image provenance: on the image first, else matched from the answer record', () => {
    const own = { markings: ['c2pa'] };
    expect(findImageProvenance({ provenance: own }, null, 0)).toBe(own);
    const record = {
      images: [
        { sha256: 'h1', markings: ['trustmark'] },
        { sha256: 'h2', markings: ['c2pa', 'xmp'] }
      ]
    };
    expect(findImageProvenance({ sha256: 'h2' }, record, 0)).toBe(record.images[1]);
    expect(findImageProvenance({}, record, 0)).toBe(record.images[0]);
    expect(findImageProvenance({}, null, 0)).toBeNull();
    expect(describeImageMarkings({ markings: ['c2pa', 'trustmark', 7] })).toEqual({
      markings: ['c2pa', 'trustmark'],
      contentCredentials: true
    });
  });
});

describe('AIInteractionNotice', () => {
  test('renders the default notice with the provider before the first message', () => {
    mockPlatformConfig = {
      aiTransparency: { ...CONFIG, provider: { legalEntity: 'ACME GmbH' } }
    };
    render(<AIInteractionNotice app={{ id: 'chat', aiTransparency: { disclosure: true } }} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      'You are chatting with an AI system operated by ACME GmbH. Answers are generated automatically and may be inaccurate — check important information.'
    );
  });

  test("uses the app's own localized notice", () => {
    render(
      <AIInteractionNotice
        app={{
          id: 'chat',
          aiTransparency: { disclosure: true, firstTurnNotice: { en: 'This is an AI helper.' } }
        }}
      />
    );
    expect(screen.getByRole('note')).toHaveTextContent('This is an AI helper.');
  });

  test('nothing for an opted-out app or with the notice switched off', () => {
    const { container, rerender } = render(
      <AIInteractionNotice app={{ id: 'chat', aiTransparency: { disclosure: false } }} />
    );
    expect(container).toBeEmptyDOMElement();
    mockPlatformConfig = {
      aiTransparency: {
        ...CONFIG,
        interactionDisclosure: { ...CONFIG.interactionDisclosure, firstTurnNotice: false }
      }
    };
    rerender(<AIInteractionNotice app={{ id: 'chat' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AIProvenanceChip', () => {
  const provenance = {
    contentId: 'prv_42',
    generatedAt: '2026-09-29T10:00:00.000Z',
    generator: { name: 'iHub Apps', version: '5.0.0' },
    model: { id: 'gpt-x', provider: 'openai' },
    marking: { status: 'unmarked', required: true, tokens: 420, reason: 'model-unmarked' }
  };

  const renderChip = props =>
    render(
      <MemoryRouter>
        <AIProvenanceChip {...props} />
      </MemoryRouter>
    );

  test('a disclosure button opens the second layer; Escape closes it', () => {
    renderChip({ provenance, models: [{ id: 'gpt-x', name: { en: 'GPT X' } }] });
    const button = screen.getByRole('button', { name: /AI generated/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: 'About this answer' });
    expect(panel).toHaveTextContent('Generated by AI in this app (iHub Apps 5.0.0)');
    expect(panel).toHaveTextContent('GPT X (gpt-x)');
    expect(panel).toHaveTextContent(
      'Not marked: the model does not watermark its output (text over 200 tokens)'
    );
    expect(panel).toHaveTextContent('prv_42');
    expect(screen.getByRole('link', { name: /Verify content/ })).toHaveAttribute('href', '/verify');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  test('without a provenance record: generic line plus the model from props', () => {
    renderChip({ provenance: null, fallbackModelId: 'local-model' });
    fireEvent.click(screen.getByRole('button', { name: /AI generated/ }));
    const panel = screen.getByRole('region');
    expect(panel).toHaveTextContent('Generated by AI in this app');
    expect(panel).toHaveTextContent('local-model');
    expect(panel).not.toHaveTextContent('Content ID');
  });
});

describe('stored messages', () => {
  test('transformStoredMessage keeps the provenance record', () => {
    const provenance = { contentId: 'prv_7', aiGenerated: true };
    expect(
      transformStoredMessage({ id: 'm1', role: 'assistant', content: 'x', provenance }).provenance
    ).toEqual(provenance);
    expect(
      transformStoredMessage({ id: 'm2', role: 'assistant', content: 'x' })
    ).not.toHaveProperty('provenance');
  });
});
