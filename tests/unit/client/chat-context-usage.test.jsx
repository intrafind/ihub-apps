import {
  computeContextUsage,
  conversationTokenFragments,
  messageTokenFragments
} from '../../../shared/contextUsage.js';
import {
  ensureTokenizer,
  estimateTokensForFragmentsSync,
  estimateTokensSync
} from '../../../client/src/shared/utils/tokenEstimatorClient.js';

/**
 * Regression coverage for issue #2283: the context-window indicator only
 * counted the pending message, so a long multiturn conversation reported a
 * tiny fraction of the context it was actually sending.
 */
describe('conversation context estimation', () => {
  beforeAll(async () => {
    // Resolve the lazily imported tokenizer chunk once so the counts below come
    // from the real BPE tables rather than the chars/4 fallback.
    await ensureTokenizer();
  });

  describe('messageTokenFragments', () => {
    it('prefers rawContent over the rendered content', () => {
      expect(messageTokenFragments({ role: 'user', content: 'shown', rawContent: 'sent' })).toEqual(
        ['sent']
      );
    });

    it('keeps an empty-string rawContent instead of falling back to content', () => {
      expect(messageTokenFragments({ role: 'user', content: 'shown', rawContent: '' })).toEqual([]);
    });

    it('includes attached document text and its file header', () => {
      const fragments = messageTokenFragments({
        role: 'user',
        content: 'summarize this',
        fileData: { fileName: 'report.pdf', displayType: 'PDF', content: 'the report body' }
      });
      expect(fragments).toEqual(['summarize this', '[File: report.pdf (PDF)]', 'the report body']);
    });

    it('handles multiple attached files', () => {
      const fragments = messageTokenFragments({
        role: 'user',
        content: 'compare',
        fileData: [
          { fileName: 'a.txt', fileType: 'text/plain', content: 'alpha' },
          { fileName: 'b.txt', fileType: 'text/plain', content: 'beta' }
        ]
      });
      expect(fragments).toContain('alpha');
      expect(fragments).toContain('beta');
    });

    it('ignores non-message input', () => {
      expect(messageTokenFragments(null)).toEqual([]);
      expect(messageTokenFragments('nope')).toEqual([]);
    });
  });

  describe('conversationTokenFragments', () => {
    const conversation = [
      { role: 'assistant', content: 'Hi there!', isGreeting: true },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' }
    ];

    it('covers every message that will be re-sent, skipping UI-only greetings', () => {
      expect(conversationTokenFragments(conversation)).toEqual([
        'first question',
        'first answer',
        'second question',
        'second answer'
      ]);
    });

    it('returns nothing when history is not sent', () => {
      expect(conversationTokenFragments(conversation, { includeHistory: false })).toEqual([]);
    });

    it('tolerates missing or malformed input', () => {
      expect(conversationTokenFragments()).toEqual([]);
      expect(conversationTokenFragments(null)).toEqual([]);
      expect(conversationTokenFragments([null, undefined])).toEqual([]);
    });
  });

  describe('estimateTokensForFragmentsSync', () => {
    it('sums the fragments and matches a single-string estimate closely', () => {
      const fragments = ['alpha beta gamma', 'delta epsilon'];
      const summed = estimateTokensForFragmentsSync(fragments);
      expect(summed).toBeGreaterThan(0);
      // Per-fragment counting can differ from one joined string by a token or
      // two at the boundaries; it must not diverge beyond that.
      const joined = estimateTokensSync(fragments.join('\n'));
      expect(Math.abs(summed - joined)).toBeLessThanOrEqual(2);
    });

    it('is stable across repeated calls (memoized counts stay correct)', () => {
      const fragments = ['repeatable fragment', 'repeatable fragment'];
      expect(estimateTokensForFragmentsSync(fragments)).toBe(
        estimateTokensForFragmentsSync(fragments)
      );
      expect(estimateTokensForFragmentsSync(['repeatable fragment'])).toBe(
        estimateTokensForFragmentsSync(fragments) / 2
      );
    });

    it('ignores non-string entries', () => {
      expect(estimateTokensForFragmentsSync([null, 42, undefined, {}, ''])).toBe(0);
      expect(estimateTokensForFragmentsSync('not an array')).toBe(0);
      expect(estimateTokensForFragmentsSync()).toBe(0);
    });
  });

  describe('the multiturn indicator', () => {
    const systemPrompt = 'You are a careful assistant. '.repeat(20);
    const history = [];
    for (let turn = 0; turn < 12; turn += 1) {
      history.push({ role: 'user', content: `Question number ${turn}. `.repeat(40) });
      history.push({ role: 'assistant', content: `Answer number ${turn}. `.repeat(60) });
    }
    const pendingMessage = 'And one more thing?';

    it('reports far more than the pending message alone', () => {
      const pendingOnly = estimateTokensSync(pendingMessage);
      const fullContext =
        estimateTokensSync(systemPrompt) +
        estimateTokensForFragmentsSync(conversationTokenFragments(history)) +
        pendingOnly;

      // The old behaviour reported `pendingOnly`; the whole conversation is
      // orders of magnitude larger.
      expect(pendingOnly).toBeLessThan(20);
      expect(fullContext).toBeGreaterThan(pendingOnly * 50);
    });

    it('grows with each additional turn', () => {
      const before = estimateTokensForFragmentsSync(conversationTokenFragments(history));
      const after = estimateTokensForFragmentsSync(
        conversationTokenFragments([
          ...history,
          { role: 'user', content: pendingMessage },
          { role: 'assistant', content: 'Sure, here you go.' }
        ])
      );
      expect(after).toBeGreaterThan(before);
    });

    it('flags an overflowing window through computeContextUsage', () => {
      const inputTokens =
        estimateTokensSync(systemPrompt) +
        estimateTokensForFragmentsSync(conversationTokenFragments(history));

      const roomy = computeContextUsage({
        contextWindow: 128000,
        inputTokens,
        maxOutputTokens: 4096
      });
      expect(roomy.remaining).toBeGreaterThan(0);
      expect(roomy.usedRatio).toBeLessThan(0.85);

      const tight = computeContextUsage({
        contextWindow: 2048,
        inputTokens,
        maxOutputTokens: 1024
      });
      expect(tight.remaining).toBeLessThan(0);
      expect(tight.usedRatio).toBeGreaterThan(1);
    });

    it('counts a re-sent attached document, not just its first turn', () => {
      const document = 'Contract clause text. '.repeat(500);
      const withAttachment = [
        {
          role: 'user',
          content: 'review this',
          fileData: { fileName: 'contract.pdf', displayType: 'PDF', content: document }
        },
        { role: 'assistant', content: 'Reviewed.' },
        { role: 'user', content: 'and the second clause?' }
      ];
      const tokens = estimateTokensForFragmentsSync(conversationTokenFragments(withAttachment));
      expect(tokens).toBeGreaterThan(estimateTokensSync(document) * 0.9);
    });
  });
});
