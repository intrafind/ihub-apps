/**
 * Timestamped and speaker-labelled transcripts.
 *
 * A batch provider that can time and attribute speech (Gemini's word
 * annotations, Whisper's `verbose_json` segments) hands over *units*:
 * `{ text, start?, end?, speaker? }`, times in seconds. This module groups them
 * into lines and renders what a chat bubble shows, one line per entry:
 *
 *   [00:12] Speaker 1: Welcome to the talk.
 *   [00:31] Speaker 2: Thanks for having me.
 *
 * The result is plain text on purpose. It is stored as the answer of the
 * transcription turn like any other transcript, so a chat model picked next can
 * answer "what was said around minute 20?" from it, and nothing on the way to
 * the browser has to learn a new frame.
 */

/** A line is cut at the next sentence end or pause once it is this long … */
const TARGET_LINE_SECONDS = 20;
/** … and at the next unit whatever it is, once it is this long. */
const MAX_LINE_SECONDS = 40;
/** A silence this long between two units is a place to cut a line. */
const PAUSE_SECONDS = 0.5;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;

/**
 * Seconds from what an API calls a duration: a number, or a protobuf duration
 * string such as `"0.450s"`.
 *
 * @param {unknown} value
 * @returns {number|null} Null when there is no usable time.
 */
export function parseOffset(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*s?\s*$/iu.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * Text for a speaker id: `spk_1` → `Speaker 1`; any other id is kept as it is.
 *
 * @param {string} id
 * @param {string} [prefix]
 * @returns {string}
 */
export function speakerName(id, prefix = 'Speaker') {
  const raw = String(id ?? '').trim();
  const numbered = /^spk[_-]?(\d+)$/iu.exec(raw);
  return numbered ? `${prefix} ${numbered[1]}` : raw;
}

/**
 * `mm:ss`, or `h:mm:ss` when the recording is an hour long or more.
 *
 * @param {number} seconds
 * @param {boolean} [withHours]
 * @returns {string}
 */
export function formatClock(seconds, withHours = false) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return withHours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

const hasTime = value => typeof value === 'number' && Number.isFinite(value);

/** A unit as `groupUnits` works with it; null when it has no text. */
function readUnit(unit, speakers) {
  const text = String(unit?.text ?? '').trim();
  if (!text) return null;
  const start = hasTime(unit.start) ? unit.start : null;
  return {
    text,
    start,
    end: hasTime(unit.end) ? unit.end : start,
    speaker: speakers && unit.speaker ? String(unit.speaker) : undefined
  };
}

/** Whether `unit` starts a new line after `line`, whose last unit was `prev`. */
function startsNewLine(line, prev, unit, splitByTime) {
  if (!line || unit.speaker !== line.speaker) return true;
  if (!splitByTime || unit.start === null || line.start === null) return false;
  const length = unit.start - line.start;
  // A unit that would end past the cap cuts as well: a Whisper segment can run
  // for half a minute, and joining three of them must not make a 54 s line.
  const endLength = (unit.end ?? unit.start) - line.start;
  if (length >= MAX_LINE_SECONDS || endLength > MAX_LINE_SECONDS) return true;
  const pause = prev?.end != null ? unit.start - prev.end : 0;
  const boundary = SENTENCE_END.test(prev?.text || '') || pause >= PAUSE_SECONDS;
  return length >= TARGET_LINE_SECONDS && boundary;
}

/**
 * Group units (words or short segments) into lines.
 *
 * A line ends when the speaker changes (`speakers`), and, with `splitByTime`,
 * at a sentence end or a pause once it has run {@link TARGET_LINE_SECONDS}
 * (never later than {@link MAX_LINE_SECONDS}). Without `splitByTime` a line is
 * a whole speaker turn.
 *
 * @param {Array<{text: string, start?: number|null, end?: number|null, speaker?: string}>} units
 * @param {{ speakers?: boolean, splitByTime?: boolean }} [options]
 * @returns {Array<{text: string, start: number|null, end: number|null, speaker?: string}>}
 */
export function groupUnits(units, { speakers = false, splitByTime = false } = {}) {
  const lines = [];
  let line = null;
  let prev = null;
  for (const raw of units) {
    const unit = readUnit(raw, speakers);
    if (!unit) continue;
    if (startsNewLine(line, prev, unit, splitByTime)) {
      line = { ...unit, parts: [unit.text] };
      lines.push(line);
    } else {
      line.parts.push(unit.text);
      if (unit.end !== null) line.end = unit.end;
    }
    prev = unit;
  }
  return lines.map(({ parts, ...rest }) => ({ ...rest, text: parts.join(' ') }));
}

/**
 * Render lines for the chat: `[mm:ss] Speaker 1: text`, one per line. A part
 * is left out when the line has none (no time, no speaker) or it is not asked
 * for.
 *
 * @param {Array<{text: string, start?: number|null, speaker?: string}>} lines
 * @param {{ timestamps?: boolean, speakers?: boolean, speakerLabel?: string }} [options]
 * @returns {string}
 */
export function formatLines(lines, { timestamps = false, speakers = false, speakerLabel } = {}) {
  const starts = lines.map(line => line.start).filter(hasTime);
  const withHours = starts.length > 0 && Math.max(...starts) >= 3600;
  return lines
    .map(line => {
      const clock =
        timestamps && hasTime(line.start) ? `[${formatClock(line.start, withHours)}]` : '';
      const who = speakers && line.speaker ? `${speakerName(line.speaker, speakerLabel)}:` : '';
      return [clock, who, line.text].filter(Boolean).join(' ');
    })
    .join('\n');
}

/**
 * Units → the finished transcript text.
 *
 * @param {Array<{text: string, start?: number|null, end?: number|null, speaker?: string}>} units
 * @param {{ timestamps?: boolean, speakers?: boolean, speakerLabel?: string }} options
 * @returns {string}
 */
export function formatTranscript(units, options = {}) {
  const { timestamps = false, speakers = false } = options;
  const lines = groupUnits(units, { speakers, splitByTime: timestamps });
  return formatLines(lines, options);
}

/**
 * Tidy a transcript assembled from a session before it is stored: runs of
 * spaces and tabs become one space and the spaces around a line break go, but
 * the line breaks stay, so an annotated transcript keeps one entry per line.
 *
 * @param {string} text
 * @returns {string}
 */
export function tidyTranscript(text) {
  return String(text ?? '')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .trim();
}

/**
 * What a model's `config` asks the transcript to show. Only a transcript meant
 * to be read (a stored chat turn) is annotated; dictation and voice mode type
 * and speak the text, where `[00:12]` would be noise.
 *
 * @param {Object} [config] - `model.config`.
 * @param {boolean} annotate - The session wants a readable transcript.
 * @returns {{ timestamps: boolean, speakers: boolean, speakerLabel?: string }}
 */
export function annotationsOf(config, annotate) {
  const speakerLabel =
    typeof config?.speakerLabel === 'string' && config.speakerLabel.trim()
      ? config.speakerLabel.trim()
      : undefined;
  return {
    timestamps: annotate === true && config?.timestamps === true,
    speakers: annotate === true && config?.speakers === true,
    speakerLabel
  };
}
