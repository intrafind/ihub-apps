#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Run two implementations on the same input and write their reports and
 * records next to each other, for people to read. Made for the law
 * consultation: the legacy workflow and the rebuilt one on the same statements.
 *
 * Nothing is asserted. The two sides are expected to differ, and which
 * differences are fine is a judgement (five of them are accepted as fixes in
 * #3786). The tool exits with 1 only when a side could not run.
 *
 *   node server/tests/golden/sideBySide.mjs \
 *     --left <module> --right <module> --input <dir> --out <dir> \
 *     [--left-label legacy] [--right-label rebuilt]
 *
 * A side is a module that exports `run` (or a default function):
 *
 *   export async function run({ input, files, label }) {
 *     // input: absolute path of the input directory; files: its file names, sorted
 *     return { report: '# Report ...', record: { ... } };
 *   }
 *
 * `report` is what the implementation produced for the user (Markdown).
 * `record` is what it did, normalised (`recordCase` of `harness.js` returns
 * one). A side can also be a golden case, as `case:<surface>/<case>`.
 *
 * Written to `--out`: `<label>.report.md`, `<label>.record.json`, and
 * `README.md` with the input, the size of both reports and the parts of the
 * records that differ.
 *
 * See docs/run-testing.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const canonical = value => `${JSON.stringify(sortKeys(value), null, 2)}\n`;

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, sortKeys(value[key])])
    );
  }
  return value;
}

/** Load a side: a module path, or `case:<surface>/<case>`. */
async function loadSide(spec) {
  if (spec.startsWith('case:')) {
    // Loaded only when asked for: the harness starts the server modules.
    const [{ recordCase }, { findCase }, { comparable }] = await Promise.all([
      import('./harness.js'),
      import('./cases.js'),
      import('./assertGolden.js')
    ]);
    const goldenCase = findCase(spec.slice('case:'.length));
    return async () => {
      const record = comparable(await recordCase(goldenCase));
      const answer = record.result?.content ?? '';
      return { report: `# ${goldenCase.id}\n\n${goldenCase.title}\n\n${answer}\n`, record };
    };
  }
  const module = await import(pathToFileURL(path.resolve(spec)).href);
  const run = module.run ?? module.default;
  if (typeof run !== 'function') {
    throw new TypeError(`${spec} exports neither run() nor a default function`);
  }
  return run;
}

/**
 * Run both sides and write the comparison.
 *
 * @param {Object} params
 * @param {string} params.left - Module path or `case:<id>`.
 * @param {string} params.right
 * @param {string} params.input - Directory with the input both sides get.
 * @param {string} params.out - Directory to write into (created).
 * @param {string} [params.leftLabel='legacy']
 * @param {string} [params.rightLabel='rebuilt']
 * @returns {Promise<{files: string[], differingParts: string[], failed: string[]}>}
 */
export async function runSideBySide({
  left,
  right,
  input,
  out,
  leftLabel = 'legacy',
  rightLabel = 'rebuilt'
}) {
  if (leftLabel === rightLabel) throw new Error('the two sides need different labels');
  const inputDir = path.resolve(input);
  const files = fs
    .readdirSync(inputDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(inputDir, path.join(entry.parentPath, entry.name)))
    .sort((a, b) => a.localeCompare(b, 'en'));
  fs.mkdirSync(out, { recursive: true });

  const written = [];
  const write = (name, content) => {
    fs.writeFileSync(path.join(out, name), content);
    written.push(name);
  };

  const sides = [];
  // One after the other: both use the process-wide storage and model client.
  for (const [label, spec] of [
    [leftLabel, left],
    [rightLabel, right]
  ]) {
    const side = { label, spec, report: null, record: null, error: null };
    try {
      const run = await loadSide(spec);
      const result = await run({ input: inputDir, files, label });
      side.report = String(result?.report ?? '');
      side.record = result?.record ?? null;
      write(`${label}.report.md`, side.report.endsWith('\n') ? side.report : `${side.report}\n`);
      write(`${label}.record.json`, canonical(side.record));
    } catch (error) {
      side.error = error;
      write(`${label}.error.txt`, `${error.stack || error.message}\n`);
    }
    sides.push(side);
  }

  const [a, b] = sides;
  const parts = new Set([...Object.keys(a.record ?? {}), ...Object.keys(b.record ?? {})]);
  const differingParts = [...parts]
    .filter(
      part =>
        JSON.stringify(sortKeys(a.record?.[part])) !== JSON.stringify(sortKeys(b.record?.[part]))
    )
    .sort();
  const failed = sides.filter(side => side.error).map(side => side.label);

  const lines = text => (text ? text.trimEnd().split('\n').length : 0);
  const row = side =>
    side.error
      ? `| ${side.label} | \`${side.spec}\` | failed: ${String(side.error.message).split('\n')[0]} | |`
      : `| ${side.label} | \`${side.spec}\` | [${side.label}.report.md](${side.label}.report.md), ${lines(side.report)} lines | [${side.label}.record.json](${side.label}.record.json) |`;
  write(
    'README.md',
    [
      '# Side by side',
      '',
      'Two implementations ran on the same input. This comparison is read by people; nothing was',
      'asserted and the two sides are expected to differ.',
      '',
      `Input: \`${inputDir}\` (${files.length} files)`,
      '',
      ...files.map(file => `- ${file}`),
      '',
      '| Side | Implementation | Report | Record |',
      '|---|---|---|---|',
      ...sides.map(row),
      '',
      'Parts of the records that differ:',
      '',
      ...(differingParts.length > 0 ? differingParts.map(part => `- ${part}`) : ['- none']),
      '',
      `The reports ${a.report === b.report ? 'are identical' : 'differ'}. ` +
        `Compare them with: \`diff -u ${a.label}.report.md ${b.label}.report.md\``,
      ''
    ].join('\n')
  );
  return { files: written, differingParts, failed };
}

function parseArgs(argv) {
  const names = {
    '--left': 'left',
    '--right': 'right',
    '--input': 'input',
    '--out': 'out',
    '--left-label': 'leftLabel',
    '--right-label': 'rightLabel'
  };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = names[argv[i]];
    if (!name || argv[i + 1] === undefined)
      throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    options[name] = argv[++i];
  }
  for (const required of ['left', 'right', 'input', 'out']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

// Run only as a script: the self-test imports runSideBySide.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { files, differingParts, failed } = await runSideBySide(options);
    console.log(`wrote ${files.join(', ')} to ${options.out}`);
    console.log(`record parts that differ: ${differingParts.join(', ') || 'none'}`);
    for (const label of failed) console.error(`the ${label} side failed, see ${label}.error.txt`);
    process.exit(failed.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(error.message);
    console.error(
      'usage: node server/tests/golden/sideBySide.mjs --left <module|case:id> --right <module|case:id> ' +
        '--input <dir> --out <dir> [--left-label legacy] [--right-label rebuilt]'
    );
    process.exit(2);
  }
}
