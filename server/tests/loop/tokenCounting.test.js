// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Count once, then add: text whose token count is known (an attachment, a
 * project document, the history the previous answer was written for) is not
 * tokenized again. `tokenizerStats` shows what went through the tokenizer.
 *
 * Run: node --test server/tests/loop/tokenCounting.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  estimateTokens,
  estimateTokensWithKnown,
  setKnownTokenParts,
  tokenizerInfo,
  tokenizerStats
} from '../../../shared/tokenEstimator.js';
import {
  createContextTracker,
  estimateMessageTokens,
  estimateTranscriptTokens
} from '../../services/loop/contextTracker.js';
import { compactIfOversized } from '../../services/loop/contextCompaction.js';
import { renderProjectsBlock } from '../../services/knowledge/KnowledgeScopePlanner.js';
import { FilesystemStorageProvider } from '../../storage/index.js';
import {
  CHAT_FILES_NAMESPACE,
  ChatFileRepository,
  chatFileKey
} from '../../services/chatFiles/ChatFileRepository.js';
import { prepareTurnFiles } from '../../services/chatFiles/ChatFileService.js';

const model = { contextWindow: 200_000, maxOutputTokens: 8_000 };

/** Distinct prose of about `chars` characters (distinct so no memo answers for it). */
function prose(chars, seed = 0) {
  const words = ['Plattform', 'Dokumente', 'Unternehmen', 'Fragen', 'Prozesse', 'Antwort'];
  const out = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const word = `${words[(i * 7 + seed) % words.length]}${(i * 31 + seed) % 997}`;
    out.push(word);
    length += word.length + 1;
  }
  return out.join(' ').slice(0, chars);
}

/** Characters the tokenizer saw while `fn` ran. */
function tokenized(fn) {
  const before = tokenizerStats.chars;
  const value = fn();
  return { value, chars: tokenizerStats.chars - before };
}

/** A chat of `turns` question/answer pairs, then a new question. */
function chat(turns, { answerChars = 2_000, system = 'You are helpful.' } = {}) {
  const messages = [{ role: 'system', content: system }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `Question ${i}: ${prose(200, i)}` });
    messages.push({ role: 'assistant', content: prose(answerChars, i + 100) });
  }
  messages.push({ role: 'user', content: 'And now the new question?' });
  return messages;
}

/** Fresh objects with the same content, like a history re-read from the store. */
const reread = messages => messages.map(m => ({ ...m }));

/** The context the previous answer stored: its prompt plus the answer, and the system share. */
function priorOf(messages, overrides = {}) {
  const previous = messages.slice(0, -1);
  return {
    contextWindow: model.contextWindow,
    inputTokens: estimateTranscriptTokens(reread(previous)),
    maxOutputTokens: model.maxOutputTokens,
    source: 'provider',
    systemTokens: estimateTokens(previous[0].content),
    ...overrides
  };
}

describe('context tracker anchored on the previous answer', () => {
  it('counts only the system prompt and the new messages, and matches a full recount', () => {
    const messages = chat(10);
    const prior = priorOf(messages);
    const full = estimateTranscriptTokens(reread(messages));
    const turn = reread(messages);
    const tracker = createContextTracker(model, { prior });
    const { value: state, chars } = tokenized(() => tracker.estimate(turn));
    const newChars = turn[0].content.length + turn[turn.length - 1].content.length;
    assert.ok(chars <= newChars, `tokenized ${chars} chars, new text is ${newChars}`);
    assert.ok(Math.abs(state.inputTokens - full) <= 2, `${state.inputTokens} vs ${full}`);
    assert.equal(state.source, 'estimate');
  });

  it('replaces the system prompt the previous turn had with this turn’s', () => {
    const messages = chat(3);
    const prior = priorOf(messages);
    const turn = reread(messages);
    turn[0] = { role: 'system', content: `${turn[0].content} ${prose(4_000, 9)}` };
    const state = createContextTracker(model, { prior }).estimate(turn);
    const full = estimateTranscriptTokens(reread(turn));
    assert.ok(Math.abs(state.inputTokens - full) <= 2, `${state.inputTokens} vs ${full}`);
  });

  it('stores the system share with the replay so the next turn can start from it', () => {
    const messages = chat(2);
    const tracker = createContextTracker(model);
    tracker.estimate(messages);
    tracker.recordStep({ promptTokens: 1_234, completionTokens: 10 }, messages.length);
    const replay = tracker.replay('the answer');
    assert.equal(replay.systemTokens, estimateTokens(messages[0].content));
    assert.equal(replay.source, 'provider');
    assert.equal(replay.inputTokens, 1_234 + estimateTokens('the answer'));
  });

  it('counts the whole transcript without a usable prior', () => {
    const messages = chat(4);
    const full = estimateTranscriptTokens(reread(messages));
    const variants = {
      'no prior': null,
      'another context window (model switched)': priorOf(messages, { contextWindow: 8_000 }),
      'stored before the system share was recorded': priorOf(messages, {
        systemTokens: undefined
      })
    };
    for (const [name, prior] of Object.entries(variants)) {
      const turn = reread(messages);
      const { value: state, chars } = tokenized(() =>
        createContextTracker(model, { prior }).estimate(turn)
      );
      assert.equal(state.inputTokens, full, name);
      assert.ok(chars > 0 || name === 'no prior', name);
    }
    // History off: the prompt holds no earlier answer, so the prior is not used.
    const single = [messages[0], messages[messages.length - 1]];
    const state = createContextTracker(model, { prior: priorOf(messages) }).estimate(single);
    assert.equal(state.inputTokens, estimateTranscriptTokens(single));
  });

  it('keeps the history boundary across steps that add answers of this turn', () => {
    const messages = chat(3);
    const prior = priorOf(messages);
    const turn = reread(messages);
    const tracker = createContextTracker(model, { prior });
    const first = tracker.estimate(turn).inputTokens;
    // A provider without usage: step 2 is estimated again, with this turn's tool call.
    turn.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'x', arguments: '{}' } }]
    });
    turn.push({ role: 'tool', content: prose(1_000, 5) });
    const second = tracker.estimate(turn).inputTokens;
    assert.equal(second, first + estimateTranscriptTokens(turn.slice(-2)));
  });

  it('starts a 2 MB second turn in well under 20 ms', () => {
    const messages = chat(20, { answerChars: 110_000 });
    const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
    assert.ok(chars > 2_000_000, `${chars}`);
    const prior = priorOf(messages);
    const turn = reread(messages);
    const started = performance.now();
    createContextTracker(model, { prior }).estimate(turn);
    const ms = performance.now() - started;
    assert.ok(ms < 20, `step-1 estimate took ${ms.toFixed(1)} ms`);
  });

  it('counts a long chat with no prior from samples, bounded and close', () => {
    const messages = chat(20, { answerChars: 30_000 });
    const exact = estimateTranscriptTokens(reread(messages));
    const started = performance.now();
    const state = createContextTracker(model).estimate(reread(messages));
    const ms = performance.now() - started;
    assert.ok(
      Math.abs(state.inputTokens - exact) / exact < 0.05,
      `${state.inputTokens} vs ${exact}`
    );
    assert.ok(ms < 50, `fresh count took ${ms.toFixed(1)} ms`);
  });
});

describe('stored counts in the prompt', () => {
  it('adds the stored count of a piece and tokenizes only the rest', () => {
    const doc = prose(50_000, 1);
    const content = `<content type="document">\n${doc}\n</content>\n\nWhat does it say?`;
    const message = { role: 'user', content };
    setKnownTokenParts(message, [{ text: doc, tokens: 12_345 }]);
    const { value, chars } = tokenized(() => estimateMessageTokens(message));
    assert.ok(chars < 200, `${chars}`);
    assert.equal(value, 12_345 + estimateTokens(content.replace(doc, '')));
    // A piece not in the text adds nothing.
    assert.equal(
      estimateTokensWithKnown('plain text', [{ text: 'absent', tokens: 99 }]),
      estimateTokens('plain text')
    );
  });

  it('reuses the stored counts of project documents in the knowledge block', () => {
    const docA = prose(40_000, 2);
    const docB = prose(40_000, 3);
    const plan = {
      projects: [
        {
          id: 'p1',
          name: 'Handbook',
          mode: 'loaded',
          injected: [
            { doc: { id: 'a', name: 'A' }, text: docA, tokens: 9_000 },
            { doc: { id: 'b', name: 'B' }, text: docB, tokens: 9_500 }
          ]
        }
      ]
    };
    const parts = [];
    const block = renderProjectsBlock(plan, parts);
    assert.equal(parts.length, 2);
    const system = {
      role: 'system',
      content: `You answer from the handbook.\n\nProjects:\n${block}`
    };
    setKnownTokenParts(system, parts);
    const { value, chars } = tokenized(() => estimateMessageTokens(system));
    assert.ok(chars < 1_000, `only the framing is tokenized (${chars})`);
    assert.ok(value > 18_500);
  });

  it('cuts 100 known pieces out in one pass, with the count the piece-by-piece cut gave', () => {
    // The cut before the cursor walk: each piece searched in, and cut out of, the whole rest.
    const pieceByPiece = (text, parts, count) => {
      let rest = text;
      let known = 0;
      for (const part of parts) {
        const at = rest.indexOf(part.text);
        if (at === -1) continue;
        known += part.tokens;
        rest = rest.slice(0, at) + rest.slice(at + part.text.length);
      }
      return known + count(rest);
    };
    const docs = Array.from({ length: 100 }, (_, i) => prose(10_000, 200 + i));
    const parts = docs.map((text, i) => ({ text, tokens: 2_000 + i }));
    const text = `You are x.\n${docs.map((d, i) => `<document id="${i}">\n${d}\n</document>`).join('\n')}`;
    // An out-of-order piece and one that is not there are handled too.
    const shuffled = [
      parts[50],
      ...parts.slice(0, 50),
      ...parts.slice(51),
      { text: 'absent', tokens: 7 }
    ];
    const count = t => estimateTokens(t);
    assert.equal(
      estimateTokensWithKnown(text, shuffled, count),
      pieceByPiece(text, shuffled, count)
    );
    estimateTokensWithKnown(`${text} warm`, parts, count);
    const started = performance.now();
    const value = estimateTokensWithKnown(`${text} 1`, parts, count);
    const ms = performance.now() - started;
    assert.equal(value, pieceByPiece(`${text} 1`, parts, count));
    assert.ok(ms < 8, `100 pieces took ${ms.toFixed(2)} ms`);
  });

  it('notes only counts that are finite numbers >= 0', () => {
    const doc = prose(5_000, 12);
    for (const tokens of [-1, 0.5 - 1, Number.NaN, Infinity, '12', null]) {
      const message = { role: 'user', content: `${doc} q` };
      setKnownTokenParts(message, [{ text: doc, tokens }]);
      assert.equal(estimateMessageTokens(message), estimateTokens(`${doc} q`), String(tokens));
    }
    const zero = { role: 'user', content: `${doc} q` };
    setKnownTokenParts(zero, [{ text: doc, tokens: 0 }]);
    assert.equal(estimateMessageTokens(zero), estimateTokens(` q`));
  });

  it('remembers a 300 KB text by its hash', () => {
    const text = prose(300_000, 4);
    const first = tokenized(() => estimateTokens(text));
    const again = tokenized(() => estimateTokens(`${text.slice(0, 10)}${text.slice(10)}`));
    assert.ok(first.chars > 0);
    assert.equal(again.chars, 0);
    assert.equal(again.value, first.value);
  });

  it('skips the compaction count when the known total is under the threshold', () => {
    const messages = [{ role: 'user', content: prose(80_000, 6) }];
    const { value, chars } = tokenized(() =>
      compactIfOversized(messages, { thresholdTokens: 50_000, knownTokens: 20_000 })
    );
    assert.equal(value.compacted, false);
    assert.equal(chars, 0);
  });
});

describe('chat attachments are counted once, when stored', () => {
  let tmpDir;
  let provider;
  let repo;
  const scope = { type: 'chat', id: 'chat-tokens' };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-token-counting-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function turnFiles(fileId) {
    const { message } = await prepareTurnFiles({
      chatId: scope.id,
      ownerId: 'u1',
      message: { role: 'user', content: 'Summarize', fileIds: [fileId] },
      store: repo
    });
    return message.fileData;
  }

  it('stores the count at upload and never tokenizes the text again', async () => {
    const text = prose(60_000, 7);
    const { value: stored, chars } = await (async () => {
      const before = tokenizerStats.chars;
      const value = await repo.put(scope, {
        ownerId: 'u1',
        name: 'a.txt',
        mimeType: 'text/plain',
        text
      });
      return { value, chars: tokenizerStats.chars - before };
    })();
    assert.equal(stored.tokens, estimateTokens(text));
    assert.ok(chars >= text.length, 'counted at upload');
    const doc = await provider.documents.get(CHAT_FILES_NAMESPACE, chatFileKey(scope, stored.id));
    assert.equal(doc.data.tokens, stored.tokens);
    assert.equal(doc.data.tokenizer, tokenizerInfo().method);

    for (let turn = 0; turn < 3; turn++) {
      const before = tokenizerStats.chars;
      const files = [await turnFiles(stored.id)].flat();
      assert.equal(files[0].tokens, stored.tokens);
      const message = {
        role: 'user',
        content: `<content>\n${files[0].content}\n</content>\n\nSummarize`
      };
      setKnownTokenParts(message, [{ text: files[0].content, tokens: files[0].tokens }]);
      estimateMessageTokens(message);
      assert.ok(tokenizerStats.chars - before < 100, `turn ${turn}: the text was not tokenized`);
    }
  });

  it('drops a count the request brought when the file stays inline', async () => {
    const { message } = await prepareTurnFiles({
      chatId: scope.id,
      ownerId: 'u1',
      message: {
        role: 'user',
        content: 'Summarize',
        fileData: [{ fileName: 'a.txt', fileType: 'text/plain', content: 'text', tokens: -5_000 }]
      },
      store: { isAvailable: () => false }
    });
    const [file] = [message.fileData].flat();
    assert.equal(file.content, 'text');
    assert.equal('tokens' in file, false);
  });

  it('counts a file stored before counts were kept once, then reuses the stored count', async () => {
    const text = prose(30_000, 8);
    const stored = await repo.put(scope, {
      ownerId: 'u1',
      name: 'old.txt',
      mimeType: 'text/plain',
      text
    });
    // Make it a legacy record: no count.
    const key = chatFileKey(scope, stored.id);
    const doc = await provider.documents.get(CHAT_FILES_NAMESPACE, key);
    const { tokens: _t, tokenizer: _m, ...legacy } = doc.data;
    await provider.documents.put(CHAT_FILES_NAMESPACE, key, legacy);

    let before = tokenizerStats.chars;
    const first = [await turnFiles(stored.id)].flat()[0];
    assert.equal(first.tokens, estimateTokens(text));
    assert.ok(tokenizerStats.chars - before >= text.length, 'counted on first use');
    assert.equal(
      (await provider.documents.get(CHAT_FILES_NAMESPACE, key)).data.tokens,
      first.tokens
    );

    before = tokenizerStats.chars;
    const second = [await turnFiles(stored.id)].flat()[0];
    assert.equal(second.tokens, first.tokens);
    assert.equal(tokenizerStats.chars - before, 0, 'not counted again');
  });
});
