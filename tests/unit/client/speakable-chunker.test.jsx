/**
 * Voice mode (issue #2868): the speakable chunker cuts a streaming answer into
 * pieces for text-to-speech. A wrong cut breaks a sentence in two with a pause
 * in the middle (or hands the server half a code fence), a missed cut only
 * delays audio — so most of these tests are about where it must NOT cut.
 */

import { createSpeakableChunker } from '../../../client/src/features/voice/utils/speakableChunker';

/** A chunker that cuts at every boundary, so each test sees the boundaries themselves. */
const eager = (opts = {}) =>
  createSpeakableChunker({ firstMinChars: 1, laterMinChars: 1, maxChars: 1500, ...opts });

/** All chunks one `update` of the whole text returns, then the final flush. */
function chunksOf(text, opts) {
  const chunker = eager(opts);
  return [...chunker.update(text), ...chunker.update(text, { final: true })];
}

/** Feed the text in pieces of `size` characters, as an LLM stream would. */
function streamed(text, { size = 1, ...opts } = {}) {
  const chunker = eager(opts);
  const out = [];
  for (let end = size; end < text.length + size; end += size) {
    out.push(...chunker.update(text.slice(0, Math.min(end, text.length))));
  }
  out.push(...chunker.update(text, { final: true }));
  return out;
}

describe('speakableChunker: sentences', () => {
  test('cuts at . ! ? followed by whitespace', () => {
    expect(chunksOf('One. Two! Three? Four.')).toEqual(['One.', 'Two!', 'Three?', 'Four.']);
  });

  test('a sentence still arriving is not complete until whitespace follows', () => {
    const chunker = eager();
    expect(chunker.update('The sentence is here.')).toEqual([]);
    expect(chunker.update('The sentence is here. ')).toEqual(['The sentence is here.']);
  });

  test('final flushes the unfinished remainder', () => {
    const chunker = eager();
    expect(chunker.update('First one. And the rest')).toEqual(['First one.']);
    expect(chunker.update('First one. And the rest', { final: true })).toEqual(['And the rest']);
  });

  test('a second final is idempotent', () => {
    const chunker = eager();
    expect(chunker.update('Only this', { final: true })).toEqual(['Only this']);
    expect(chunker.update('Only this', { final: true })).toEqual([]);
    expect(chunker.update('Only this', { final: true })).toEqual([]);
  });

  test('update returns only what became complete since the last call', () => {
    const chunker = eager();
    expect(chunker.update('Alpha. Beta')).toEqual(['Alpha.']);
    expect(chunker.update('Alpha. Beta. Gam')).toEqual(['Beta.']);
    expect(chunker.update('Alpha. Beta. Gamma. ')).toEqual(['Gamma.']);
    expect(chunker.update('Alpha. Beta. Gamma. ')).toEqual([]);
  });

  test('a paragraph break ends a chunk even without punctuation', () => {
    expect(chunksOf('# A heading\n\nBody without a full stop\n\nLast paragraph')).toEqual([
      '# A heading',
      'Body without a full stop',
      'Last paragraph'
    ]);
  });

  test('a single line break is not a paragraph break', () => {
    expect(chunksOf('Soft wrapped line\nthat goes on')).toEqual([
      'Soft wrapped line\nthat goes on'
    ]);
  });

  test('a sentence end before a line break counts', () => {
    expect(chunksOf('First sentence.\nSecond sentence.')).toEqual([
      'First sentence.',
      'Second sentence.'
    ]);
  });

  test('handles CRLF line breaks', () => {
    expect(chunksOf('First sentence.\r\nSecond sentence.\r\n\r\nThird')).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third'
    ]);
  });

  test('? and ! runs end the sentence once', () => {
    expect(chunksOf('Really?! Yes!!! Fine.')).toEqual(['Really?!', 'Yes!!!', 'Fine.']);
  });

  test('non-string input is treated as empty', () => {
    const chunker = eager();
    expect(chunker.update(undefined)).toEqual([]);
    expect(chunker.update(null, { final: true })).toEqual([]);
    expect(chunker.update(42)).toEqual([]);
  });
});

describe('speakableChunker: where a full stop does not end a sentence', () => {
  test.each([
    [
      'English "e.g."',
      'Use fruit, e.g. apples or pears. Then eat.',
      'Use fruit, e.g. apples or pears.'
    ],
    ['English "i.e."', 'It is cheap, i.e. free. Nice.', 'It is cheap, i.e. free.'],
    ['"etc."', 'Bring pens, paper, etc. Then sit down.', 'Bring pens, paper, etc. Then sit down.'],
    ['"vs."', 'Cats vs. dogs is a classic. Next.', 'Cats vs. dogs is a classic.'],
    ['"Dr."', 'Dr. Smith will see you now. Please wait.', 'Dr. Smith will see you now.'],
    ['"ca."', 'It costs ca. 5 euros. Cheap.', 'It costs ca. 5 euros.'],
    ['"Nr."', 'Siehe Nr. 5 oben. Danke.', 'Siehe Nr. 5 oben.'],
    ['German "z. B."', 'Nimm Obst, z. B. Äpfel. Danke.', 'Nimm Obst, z. B. Äpfel.'],
    ['German "d. h."', 'Es ist gratis, d. h. kostenlos. Super.', 'Es ist gratis, d. h. kostenlos.'],
    ['German "u. a."', 'Wir sprachen u. a. über Preise. Gut.', 'Wir sprachen u. a. über Preise.'],
    [
      'German "bzw."',
      'Das gilt für Sie bzw. für Ihre Firma. Gut.',
      'Das gilt für Sie bzw. für Ihre Firma.'
    ],
    ['"z.B." without spaces', 'Nimm Obst, z.B. Äpfel. Danke.', 'Nimm Obst, z.B. Äpfel.'],
    ['initials', 'Ask J. R. Smith about it. Done.', 'Ask J. R. Smith about it.'],
    ['"U.S."', 'The U.S. economy grew. Good.', 'The U.S. economy grew.']
  ])('%s', (_name, text, first) => {
    const [head] = chunksOf(text);
    expect(head).toBe(first);
  });

  test('abbreviations are not matched inside longer words', () => {
    // "pizza." is not "pp." / "ca." and ends its sentence.
    expect(chunksOf('I ate pizza. Then I left.')).toEqual(['I ate pizza.', 'Then I left.']);
    expect(chunksOf('Das ist Musika. Danke.')).toEqual(['Das ist Musika.', 'Danke.']);
  });

  test.each([
    ['3.5', 'It costs 3.5 million. Wow.', 'It costs 3.5 million.'],
    ['1,000.50', 'Pay 1,000.50 dollars. Wow.', 'Pay 1,000.50 dollars.'],
    ['3,5', 'Das sind 3,5 Prozent. Wow.', 'Das sind 3,5 Prozent.'],
    ['0.7', 'Set it to 0.7 and retry. Wow.', 'Set it to 0.7 and retry.']
  ])('inside the decimal %s', (_name, text, first) => {
    expect(chunksOf(text)[0]).toBe(first);
  });

  test('a decimal at the end of a sentence still ends it', () => {
    expect(chunksOf('The version is 3.5. It is new.')).toEqual([
      'The version is 3.5.',
      'It is new.'
    ]);
    expect(chunksOf('Das macht 3,5. Danach geht es weiter.')).toEqual([
      'Das macht 3,5.',
      'Danach geht es weiter.'
    ]);
  });

  test('a year at the end of a sentence still ends it', () => {
    expect(chunksOf('It happened in 1999. Then it ended.')).toEqual([
      'It happened in 1999.',
      'Then it ended.'
    ]);
  });

  test.each([
    [
      'am 3. Oktober',
      'Wir treffen uns am 3. Oktober im Büro. Bis dann.',
      'Wir treffen uns am 3. Oktober im Büro.'
    ],
    ['am 21. Mai', 'Das war am 21. Mai 2024 so. Bis dann.', 'Das war am 21. Mai 2024 so.'],
    ['im 2. Quartal', 'Im 2. Quartal stieg der Umsatz. Gut.', 'Im 2. Quartal stieg der Umsatz.']
  ])('German ordinal %s', (_name, text, first) => {
    expect(chunksOf(text)[0]).toBe(first);
  });

  test('an ordinal-like number followed by a line break ends the sentence', () => {
    expect(chunksOf('Schritt 3.\nWeiter geht es.')).toEqual(['Schritt 3.', 'Weiter geht es.']);
  });

  test('a lowercase word after the full stop means the sentence goes on', () => {
    expect(chunksOf('It takes approx. five minutes. Done.')[0]).toBe(
      'It takes approx. five minutes.'
    );
    expect(chunksOf('Siehe auch sog. Standardfälle. Ende.')[0]).toBe(
      'Siehe auch sog. Standardfälle.'
    );
    // An unknown abbreviation followed by a lowercase word is still not cut.
    expect(chunksOf('Das Gerät der Fa. mustermann ist hier. Ende.')[0]).toBe(
      'Das Gerät der Fa. mustermann ist hier.'
    );
  });

  test('a URL is no boundary', () => {
    expect(chunksOf('See example.com/x.html for details. Then go.')).toEqual([
      'See example.com/x.html for details.',
      'Then go.'
    ]);
    expect(chunksOf('Open https://example.org/a.b.c?x=1&y=2 now. Then go.')[0]).toBe(
      'Open https://example.org/a.b.c?x=1&y=2 now.'
    );
  });

  test('a URL at the end of a sentence ends it', () => {
    expect(chunksOf('Visit example.com. Then relax.')).toEqual([
      'Visit example.com.',
      'Then relax.'
    ]);
  });

  test('"e.g.," and a dot before a comma are no boundaries', () => {
    expect(chunksOf('Many fruits, e.g., apples, are good. Yes.')[0]).toBe(
      'Many fruits, e.g., apples, are good.'
    );
  });

  test('a possessive does not look like an initial', () => {
    expect(chunksOf("That is Peter's. Next one.")).toEqual(["That is Peter's.", 'Next one.']);
  });
});

describe('speakableChunker: ellipsis, quotes and brackets', () => {
  test('an ellipsis ends the sentence once', () => {
    expect(chunksOf('Well… I think so. Maybe')).toEqual(['Well…', 'I think so.', 'Maybe']);
    expect(chunksOf('Well... I think so. Maybe')).toEqual(['Well...', 'I think so.', 'Maybe']);
  });

  test('an ellipsis is not three sentence ends', () => {
    expect(chunksOf('Wait.... Really? Yes.')).toEqual(['Wait....', 'Really?', 'Yes.']);
  });

  test('the lowercase check only applies once the next word has started', () => {
    // Whitespace alone completes a sentence (the next token may be far away) ...
    expect(eager().update('In short... ')).toEqual(['In short...']);
    // ... a lowercase word that is already there keeps it going.
    expect(eager().update('In short... it')).toEqual([]);
  });

  test('a lowercase word after an ellipsis means the sentence goes on', () => {
    expect(chunksOf('In short... it depends. Next.')).toEqual(['In short... it depends.', 'Next.']);
    expect(chunksOf('Hmm… let me think. Done.')).toEqual(['Hmm… let me think.', 'Done.']);
  });

  test('closing quotes and brackets belong to the sentence', () => {
    expect(chunksOf('He said "Stop." Then he left.')).toEqual(['He said "Stop."', 'Then he left.']);
    expect(chunksOf('It is true (see above.) Then more.')).toEqual([
      'It is true (see above.)',
      'Then more.'
    ]);
    expect(chunksOf('Er sagte „Halt.“ Dann ging er.')).toEqual([
      'Er sagte „Halt.“',
      'Dann ging er.'
    ]);
    expect(chunksOf('Sie sagte »Nein!« Dann ging sie.')).toEqual([
      'Sie sagte »Nein!«',
      'Dann ging sie.'
    ]);
    expect(chunksOf("They said 'No.' Then left.")).toEqual(["They said 'No.'", 'Then left.']);
  });

  test('closing emphasis marks belong to the sentence', () => {
    expect(chunksOf('This is **very important.** Next point.')).toEqual([
      'This is **very important.**',
      'Next point.'
    ]);
  });

  test('a link label ending in a full stop is no boundary', () => {
    expect(chunksOf('Read [the docs.](https://x.org/d) It helps.')).toEqual([
      'Read [the docs.](https://x.org/d) It helps.'
    ]);
  });
});

describe('speakableChunker: lists', () => {
  test('numbered list markers are not sentence ends', () => {
    const text = '1. Open the app\n2. Click save\n3. Close it\n\nThat is all.';
    expect(chunksOf(text)).toEqual(['1. Open the app\n2. Click save\n3. Close it', 'That is all.']);
  });

  test('list items without punctuation do not end a chunk', () => {
    const text = '- apples\n- pears\n- plums';
    expect(chunksOf(text)).toEqual(['- apples\n- pears\n- plums']);
    expect(eager().update(text)).toEqual([]);
  });

  test('a list item ends a chunk at its sentence end', () => {
    const text = '- First item is done.\n- Second item is done.\n- Third';
    expect(chunksOf(text)).toEqual(['- First item is done.', '- Second item is done.', '- Third']);
  });

  test('a letter list marker is not a sentence end', () => {
    expect(chunksOf('A. First choice\nB. Second choice\n\nPick one.')).toEqual([
      'A. First choice\nB. Second choice',
      'Pick one.'
    ]);
  });

  test('a list ends at the paragraph break after it', () => {
    const chunker = eager();
    expect(chunker.update('Steps:\n1. One\n2. Two\n\nNext')).toEqual(['Steps:\n1. One\n2. Two']);
  });
});

describe('speakableChunker: code fences', () => {
  const code = '```js\nconst a = 1. b;\nif (x) {\n  y();\n}\n```';

  test('a closed fence is never cut and ends a chunk', () => {
    expect(chunksOf(`Here is code.\n\n${code}\n\nDone. Bye.`)).toEqual([
      'Here is code.',
      code,
      'Done.',
      'Bye.'
    ]);
  });

  test('sentences and blank lines inside the fence do not cut', () => {
    const inner = '```\nOne. Two! Three?\n\nFour.\n```';
    expect(chunksOf(inner)).toEqual([inner]);
  });

  test('an open fence is held back, even across updates', () => {
    const chunker = eager();
    expect(chunker.update('Intro text. ')).toEqual(['Intro text.']);
    expect(chunker.update('Intro text. \n```py\nprint(1)\n')).toEqual([]);
    expect(chunker.update('Intro text. \n```py\nprint(1)\nprint(2). Yes.\n\nmore')).toEqual([]);
    expect(
      chunker.update('Intro text. \n```py\nprint(1)\nprint(2). Yes.\n\nmore\n```\nAfter it.')
    ).toEqual(['```py\nprint(1)\nprint(2). Yes.\n\nmore\n```']);
    expect(
      chunker.update('Intro text. \n```py\nprint(1)\nprint(2). Yes.\n\nmore\n```\nAfter it.', {
        final: true
      })
    ).toEqual(['After it.']);
  });

  test('a fence mark in the middle of a line is no fence', () => {
    expect(chunksOf('Say ```hi``` now. Then go.')).toEqual(['Say ```hi``` now.', 'Then go.']);
  });

  test('the closing fence is only recognised once its line is complete', () => {
    const chunker = eager();
    expect(chunker.update('```js\nlet a = 1;\n```')).toEqual([]);
    // "```" may still grow into "```js": still the same open block.
    expect(chunker.update('```js\nlet a = 1;\n```\nDone')).toEqual(['```js\nlet a = 1;\n```']);
  });

  test('an unclosed fence is flushed whole on final', () => {
    const chunker = eager();
    const text = 'Before. \n```js\nOne. Two.\nThree.';
    expect(chunker.update(text)).toEqual(['Before.']);
    expect(chunker.update(text, { final: true })).toEqual(['```js\nOne. Two.\nThree.']);
  });

  test('a longer fence is not closed by a shorter one', () => {
    const text = '````md\n```\nnested\n```\n````\nAfter.';
    expect(chunksOf(text)).toEqual(['````md\n```\nnested\n```\n````', 'After.']);
  });

  test('tilde fences work the same', () => {
    expect(chunksOf('~~~\nOne. Two.\n~~~\nAfter.')).toEqual(['~~~\nOne. Two.\n~~~', 'After.']);
  });

  test('a fence nested in a list item (indented) is kept whole', () => {
    const text = '1. Run it:\n   ```sh\n   npm test. now\n   ```\n2. Done.';
    expect(chunksOf(text)).toEqual(['1. Run it:\n   ```sh\n   npm test. now\n   ```', '2. Done.']);
  });

  test('a fence longer than maxChars is not hard-split', () => {
    const big = `\`\`\`\n${'x = 1;\n'.repeat(100)}\`\`\``;
    const chunks = chunksOf(`${big}\nAfter.`, { maxChars: 100 });
    expect(chunks).toEqual([big, 'After.']);
  });

  test('text before a long open fence is cut before the fence, not inside it', () => {
    const chunker = eager({ maxChars: 100 });
    const text = `Intro words here\n\`\`\`\n${'y = 2;\n'.repeat(50)}`;
    expect(chunker.update(text)).toEqual(['Intro words here']);
    expect(chunker.update(text, { final: true })).toEqual([text.slice(text.indexOf('```')).trim()]);
  });
});

describe('speakableChunker: tables', () => {
  const table = '| a | b |\n|---|---|\n| 1. x | 2. y |';

  test('the table is kept whole and flushed when it ends', () => {
    expect(chunksOf(`Data:\n\n${table}\n\nThat is it.`)).toEqual(['Data:', table, 'That is it.']);
  });

  test('a table at the end of the text is held until a non-table line follows', () => {
    const chunker = eager();
    expect(chunker.update(`${table}`)).toEqual([]);
    expect(chunker.update(`${table}\n`)).toEqual([]);
    expect(chunker.update(`${table}\n| 3 | 4 |\n`)).toEqual([]);
    expect(chunker.update(`${table}\n| 3 | 4 |\nAfter`)).toEqual([`${table}\n| 3 | 4 |`]);
  });

  test('a blank line after the table ends it', () => {
    const chunker = eager();
    expect(chunker.update(`${table}\n\n`)).toEqual([table]);
  });

  test('sentences inside table cells do not cut', () => {
    const cells = '| One. Two. | Three! |\n| e.g. x. y | z |';
    expect(chunksOf(cells)).toEqual([cells]);
  });

  test('text directly before a table stays with it (no cut at a colon)', () => {
    expect(chunksOf(`Here is the data:\n${table}\nDone.`)).toEqual([
      `Here is the data:\n${table}`,
      'Done.'
    ]);
  });

  test('a sentence before the table may end its own chunk', () => {
    expect(chunksOf(`Short intro. Look:\n${table}\nDone.`)).toEqual([
      'Short intro.',
      `Look:\n${table}`,
      'Done.'
    ]);
  });

  test('a table still arriving line by line is never cut', () => {
    const text = `Intro\n\n${table}\n| 5 | 6 |\n\nOutro.`;
    const out = streamed(text);
    expect(out).toEqual(['Intro', `${table}\n| 5 | 6 |`, 'Outro.']);
  });

  test('final flushes an open table', () => {
    const chunker = eager();
    expect(chunker.update(table)).toEqual([]);
    expect(chunker.update(table, { final: true })).toEqual([table]);
  });
});

describe('speakableChunker: chunk sizes', () => {
  const sentence = n => `This is sentence number ${n} of the answer.`;
  const text = Array.from({ length: 12 }, (_, i) => sentence(i + 1)).join(' ');

  test('the first chunk is short, later chunks are longer', () => {
    const chunker = createSpeakableChunker({
      firstMinChars: 30,
      laterMinChars: 120,
      maxChars: 500
    });
    const chunks = [...chunker.update(`${text} `), ...chunker.update(text, { final: true })];
    expect(chunks[0]).toBe(sentence(1));
    for (const later of chunks.slice(1, -1)) expect(later.length).toBeGreaterThanOrEqual(120);
    expect(chunks.join(' ')).toBe(text);
  });

  test('the first chunk waits for firstMinChars', () => {
    const chunker = createSpeakableChunker({ firstMinChars: 30, laterMinChars: 120 });
    expect(chunker.update('Short one. ')).toEqual([]);
    expect(chunker.update('Short one. Another one that is longer. ')).toEqual([
      'Short one. Another one that is longer.'
    ]);
  });

  test('the first chunk ends at a sentence end, not at the minimum', () => {
    const chunker = createSpeakableChunker({ firstMinChars: 10, laterMinChars: 200 });
    const [first] = chunker.update('This sentence is clearly longer than ten characters. More ');
    expect(first).toBe('This sentence is clearly longer than ten characters.');
  });

  test('default minimums are 30 and 250', () => {
    const chunker = createSpeakableChunker();
    const first = 'This is the first sentence of it.';
    expect(chunker.update(`${first} `)).toEqual([first]);
    const medium = 'A medium sentence that is not long enough alone. ';
    expect(chunker.update(`${first} ${medium}`)).toEqual([]);
    const more = Array.from(
      { length: 10 },
      (_, i) => `Another sentence about ${'abcdefghij'[i]}x.`
    ).join(' ');
    const out = chunker.update(`${first} ${medium}${more} `);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBeGreaterThanOrEqual(250);
  });

  test('a long sentence is hard-split at a space, at most maxChars', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const chunker = createSpeakableChunker({ firstMinChars: 1, laterMinChars: 1, maxChars: 80 });
    const chunks = [
      ...chunker.update(`${words}.`),
      ...chunker.update(`${words}.`, { final: true })
    ];
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
      expect(chunk).not.toMatch(/^\s|\s$/);
    }
    // No word was cut in half and none got lost.
    expect(chunks.join(' ')).toBe(`${words}.`);
  });

  test('a long unfinished run is split while it is still arriving', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const chunker = createSpeakableChunker({ firstMinChars: 1, laterMinChars: 1, maxChars: 80 });
    const early = chunker.update(words.slice(0, 200));
    expect(early.length).toBeGreaterThanOrEqual(1);
    for (const chunk of early) expect(chunk.length).toBeLessThanOrEqual(80);
    // The word that was still arriving is never part of an early chunk.
    expect(words.startsWith(early.join(' '))).toBe(true);
    expect(early.join(' ').length).toBeLessThan(200);
  });

  test('a hard split prefers a line break in the second half of the window', () => {
    const line = 'x'.repeat(10);
    const text = `${Array(6).fill(line).join(' ')}\n${Array(6).fill(line).join(' ')}`;
    const chunker = createSpeakableChunker({ firstMinChars: 1, laterMinChars: 1, maxChars: 80 });
    const chunks = chunker.update(text, { final: true });
    expect(chunks[0]).toBe(Array(6).fill(line).join(' '));
  });

  test('a single word longer than maxChars is cut at the limit', () => {
    const chunker = createSpeakableChunker({ firstMinChars: 1, laterMinChars: 1, maxChars: 50 });
    const chunks = chunker.update('x'.repeat(120), { final: true });
    expect(chunks.map(c => c.length)).toEqual([50, 50, 20]);
  });

  test('an earlier boundary is used when the next sentence would overflow maxChars', () => {
    const a = 'Alpha beta gamma delta epsilon.';
    const b = 'Zeta eta theta iota kappa lambda mu nu.';
    const chunker = createSpeakableChunker({
      firstMinChars: 100,
      laterMinChars: 100,
      maxChars: 60
    });
    const chunks = chunker.update(`${a} ${b} `);
    expect(chunks).toEqual([a]);
    expect(chunker.update(`${a} ${b} `, { final: true })).toEqual([b]);
  });
});

describe('speakableChunker: state', () => {
  test('reset starts a new answer', () => {
    const chunker = eager();
    expect(chunker.update('One. Two. ')).toEqual(['One.', 'Two.']);
    chunker.reset();
    expect(chunker.update('Three. Four. ')).toEqual(['Three.', 'Four.']);
  });

  test('reset makes the first chunk short again', () => {
    const chunker = createSpeakableChunker({ firstMinChars: 5, laterMinChars: 100 });
    expect(chunker.update('Hello there. ')).toEqual(['Hello there.']);
    expect(chunker.update('Hello there. Short. ')).toEqual([]);
    chunker.reset();
    expect(chunker.update('Short one. ')).toEqual(['Short one.']);
  });

  test('text that got shorter clamps the offset instead of throwing', () => {
    const chunker = eager();
    expect(chunker.update('Alpha. Beta. Gamma. ')).toEqual(['Alpha.', 'Beta.', 'Gamma.']);
    expect(() => chunker.update('Al. ')).not.toThrow();
    expect(chunker.update('Al. ')).toEqual([]);
    // Growing again continues from the clamped offset.
    expect(chunker.update('Al. New text here. ')).toEqual(['New text here.']);
  });

  test('empty and whitespace-only input yields nothing', () => {
    const chunker = eager();
    expect(chunker.update('')).toEqual([]);
    expect(chunker.update('  \n\n ', { final: true })).toEqual([]);
  });

  test('feeding the text character by character gives the same chunks as feeding it at once', () => {
    const text = [
      'Hello there, this is the first sentence. It has e.g. an abbreviation and 3.5 million.',
      '',
      'Am 3. Oktober gibt es z. B. Kuchen, d. h. viel Spaß!',
      '',
      '1. First step\n2. Second step. Done.',
      '',
      '```js\nconst a = 1. b;\n```',
      '',
      '| a | b |\n|---|---|\n| 1 | 2 |',
      '',
      'Visit example.com/x.html now. He said "Stop." Then… Silence.'
    ].join('\n');
    const oneShot = chunksOf(text);
    for (const size of [1, 2, 3, 7, 13]) expect(streamed(text, { size })).toEqual(oneShot);
    // Nothing but whitespace was lost.
    expect(oneShot.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  test('streaming with the default minimums never loses text', () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i} has some words in it, e.g. a few. And more.`
    ).join(' ');
    const chunker = createSpeakableChunker();
    const out = [];
    for (let end = 1; end <= text.length; end += 5) out.push(...chunker.update(text.slice(0, end)));
    out.push(...chunker.update(text, { final: true }));
    expect(out.join(' ')).toBe(text);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(1500);
  });
});
