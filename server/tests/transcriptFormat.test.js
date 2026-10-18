/**
 * Timestamped and speaker-labelled transcripts — unit tests.
 *
 * Units (Gemini's words, Whisper's segments) become lines such as
 * `[00:12] Speaker 1: …`: how a time is read, how a speaker is named, where a
 * line ends, and what a model's config does and does not ask for.
 */
import {
  annotationsOf,
  formatClock,
  formatLines,
  formatTranscript,
  groupUnits,
  parseOffset,
  speakerName,
  tidyTranscript
} from '../transcription/transcriptFormat.js';

/** Words of one sentence, 0.4 s apart, from `start`. */
const words = (text, start, speaker) =>
  text.split(' ').map((word, i) => ({
    text: word,
    start: start + i * 0.4,
    end: start + i * 0.4 + 0.3,
    speaker
  }));

describe('parseOffset', () => {
  test.each([
    ['0.100s', 0.1],
    ['12s', 12],
    ['3600.5s', 3600.5],
    [' 1.5 s ', 1.5],
    [2.25, 2.25],
    ['7', 7]
  ])('%p → %p', (value, expected) => {
    expect(parseOffset(value)).toBe(expected);
  });

  test.each([[undefined], [null], [''], ['soon'], [NaN], [{}], ['1m']])('%p has no time', value => {
    expect(parseOffset(value)).toBeNull();
  });
});

describe('speakerName', () => {
  test('numbers a Gemini speaker id', () => {
    expect(speakerName('spk_1')).toBe('Speaker 1');
    expect(speakerName('SPK_12')).toBe('Speaker 12');
    expect(speakerName('spk_2', 'Sprecher')).toBe('Sprecher 2');
  });

  test('keeps any other id as it is', () => {
    expect(speakerName('Dana')).toBe('Dana');
    expect(speakerName('  A ')).toBe('A');
  });
});

describe('formatClock', () => {
  test('mm:ss under an hour, h:mm:ss when asked', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(75.9)).toBe('01:15');
    expect(formatClock(1800)).toBe('30:00');
    expect(formatClock(3725, true)).toBe('1:02:05');
    expect(formatClock(75, true)).toBe('0:01:15');
  });

  test('a negative time is zero', () => {
    expect(formatClock(-3)).toBe('00:00');
  });
});

describe('groupUnits', () => {
  test('a speaker change ends a line, and a speaker turn is one line without timestamps', () => {
    const units = [
      ...words('Welcome to the talk', 0, 'spk_1'),
      ...words('Thanks for having me', 10, 'spk_2'),
      ...words('Glad you could come', 20, 'spk_1')
    ];
    const lines = groupUnits(units, { speakers: true });
    expect(lines.map(line => [line.speaker, line.text])).toEqual([
      ['spk_1', 'Welcome to the talk'],
      ['spk_2', 'Thanks for having me'],
      ['spk_1', 'Glad you could come']
    ]);
  });

  test('without speakers, a different speaker id does not split a line', () => {
    const lines = groupUnits([...words('one two', 0, 'spk_1'), ...words('three', 1, 'spk_2')]);
    expect(lines).toHaveLength(1);
    expect(lines[0].speaker).toBeUndefined();
  });

  test('by time, a line runs to the first sentence end after 20 s', () => {
    // A word every second; a full stop after every 8th.
    const units = Array.from({ length: 60 }, (_, i) => ({
      text: i % 8 === 7 ? `w${i}.` : `w${i}`,
      start: i,
      end: i + 0.8
    }));
    const lines = groupUnits(units, { splitByTime: true });
    // 20 s is reached inside the third sentence; it ends at word 23 (a full stop).
    expect(lines[0].start).toBe(0);
    expect(lines[0].text.endsWith('w23.')).toBe(true);
    expect(lines[1].start).toBe(24);
  });

  test('a pause is a place to cut once the line is long enough', () => {
    const units = [
      ...Array.from({ length: 25 }, (_, i) => ({ text: `a${i}`, start: i, end: i + 0.9 })),
      { text: 'after', start: 26, end: 26.5 } // 1.1 s of silence before it
    ];
    const lines = groupUnits(units, { splitByTime: true });
    expect(lines.map(line => line.text.split(' ').pop())).toEqual(['a24', 'after']);
  });

  test('a line is cut at 40 s even without a sentence end or a pause', () => {
    const units = Array.from({ length: 100 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 1 }));
    const lines = groupUnits(units, { splitByTime: true });
    expect(lines.map(line => line.start)).toEqual([0, 40, 80]);
  });

  test('a unit that would end past 40 s starts a new line, even when it starts before', () => {
    // Whisper segments: 0–18, 18–36 and 36–54 s, no sentence end, no pause.
    const segments = [
      { text: 'a', start: 0, end: 18 },
      { text: 'b', start: 18, end: 36 },
      { text: 'c', start: 36, end: 54 }
    ];
    const lines = groupUnits(segments, { splitByTime: true });
    expect(lines.map(line => [line.start, line.text])).toEqual([
      [0, 'a b'],
      [36, 'c']
    ]);
  });

  test('without splitByTime a long stretch stays one line', () => {
    const units = Array.from({ length: 100 }, (_, i) => ({ text: `w${i}.`, start: i, end: i + 1 }));
    expect(groupUnits(units)).toHaveLength(1);
  });

  test('empty units are skipped and units without times still group', () => {
    const lines = groupUnits(
      [{ text: 'a' }, { text: '  ' }, { text: '' }, { text: 'b', start: null }],
      { splitByTime: true }
    );
    expect(lines).toEqual([{ text: 'a b', start: null, end: null, speaker: undefined }]);
  });
});

describe('formatLines', () => {
  const lines = [
    { text: 'Hello.', start: 0, speaker: 'spk_1' },
    { text: 'Hi.', start: 75, speaker: 'spk_2' }
  ];

  test('timestamps and speakers together', () => {
    expect(formatLines(lines, { timestamps: true, speakers: true })).toBe(
      '[00:00] Speaker 1: Hello.\n[01:15] Speaker 2: Hi.'
    );
  });

  test('timestamps only, speakers only', () => {
    expect(formatLines(lines, { timestamps: true })).toBe('[00:00] Hello.\n[01:15] Hi.');
    expect(formatLines(lines, { speakers: true })).toBe('Speaker 1: Hello.\nSpeaker 2: Hi.');
  });

  test('the speaker label is configurable', () => {
    expect(formatLines(lines, { speakers: true, speakerLabel: 'Sprecher' })).toBe(
      'Sprecher 1: Hello.\nSprecher 2: Hi.'
    );
  });

  test('every time carries the hours when the recording runs past an hour', () => {
    const long = [
      { text: 'start', start: 5 },
      { text: 'end', start: 3700 }
    ];
    expect(formatLines(long, { timestamps: true })).toBe('[0:00:05] start\n[1:01:40] end');
  });

  test('a line without a time or speaker has no empty brackets', () => {
    expect(
      formatLines([{ text: 'plain', start: null }], { timestamps: true, speakers: true })
    ).toBe('plain');
  });
});

describe('formatTranscript', () => {
  test('timestamps and speakers over words', () => {
    const units = [
      ...words('Welcome to the talk', 0, 'spk_1'),
      ...words('Thanks for having me', 5, 'spk_2')
    ];
    expect(formatTranscript(units, { timestamps: true, speakers: true })).toBe(
      '[00:00] Speaker 1: Welcome to the talk\n[00:05] Speaker 2: Thanks for having me'
    );
  });

  test('Whisper segments (leading spaces and all) become timed lines', () => {
    const segments = [
      { text: ' Guten Tag.', start: 0, end: 2 },
      { text: ' Heute geht es um iHub.', start: 2, end: 6 },
      { text: ' Los geht’s.', start: 21, end: 23 },
      { text: ' Erstens.', start: 23, end: 25 }
    ];
    // The line is 21 s old when the third segment starts, and the second ended
    // a sentence: that is where it is cut.
    expect(formatTranscript(segments, { timestamps: true })).toBe(
      '[00:00] Guten Tag. Heute geht es um iHub.\n[00:21] Los geht’s. Erstens.'
    );
  });
});

describe('annotationsOf', () => {
  test('nothing is asked for unless the transcript is meant to be read', () => {
    const config = { timestamps: true, speakers: true };
    expect(annotationsOf(config, false)).toMatchObject({ timestamps: false, speakers: false });
    expect(annotationsOf(config)).toMatchObject({ timestamps: false, speakers: false });
    expect(annotationsOf(config, true)).toMatchObject({ timestamps: true, speakers: true });
  });

  test('only a literal true switches a feature on', () => {
    expect(annotationsOf({ timestamps: 'yes', speakers: 1 }, true)).toMatchObject({
      timestamps: false,
      speakers: false
    });
    expect(annotationsOf(undefined, true)).toMatchObject({ timestamps: false, speakers: false });
  });

  test('the speaker label is trimmed and ignored when blank', () => {
    expect(annotationsOf({ speakerLabel: ' Sprecher ' }, true).speakerLabel).toBe('Sprecher');
    expect(annotationsOf({ speakerLabel: '  ' }, true).speakerLabel).toBeUndefined();
    expect(annotationsOf({ speakerLabel: 5 }, true).speakerLabel).toBeUndefined();
  });
});

describe('tidyTranscript', () => {
  test('collapses runs of spaces and trims, as a one-line transcript always was', () => {
    expect(tidyTranscript('  Hello   there \t world  ')).toBe('Hello there world');
  });

  test('keeps the line breaks of an annotated transcript', () => {
    expect(tidyTranscript('[00:00]  Speaker 1: Hello.  \n  [00:21] Speaker 2: Hi.\r\n')).toBe(
      '[00:00] Speaker 1: Hello.\n[00:21] Speaker 2: Hi.'
    );
  });

  test('has nothing to tidy in nothing', () => {
    expect(tidyTranscript('')).toBe('');
    expect(tidyTranscript(undefined)).toBe('');
  });
});
