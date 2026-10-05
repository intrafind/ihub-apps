/**
 * `ihub verify <file|-> …` — the offline detector (concept §8.4; issue #2573).
 *
 * Runs the same DetectionService as `/verify`, locally, without starting the
 * server and without uploading anything (CoP 2.1.1 "software", guidelines
 * ¶76 "locally executable"). Checks C2PA manifests, TrustMark image
 * watermarks, IPTC/XMP metadata, iHub export manifests and text signposts.
 *
 * Trust: signatures validate cryptographically everywhere; a signer counts as
 * *trusted* when it chains to an anchor — the installation's own root when
 * run inside an installation (`--contents`), plus any `--trust-anchor` PEM.
 * Text watermark detection needs the installation's key groups and a
 * detector, so it only runs inside an installation with `--text-watermark`.
 *
 * Usage:
 *   ihub verify [--json] [--report <out.json>] [--trust-anchor <pem>]…
 *               [--text-watermark] [--sign] <file|-> …
 *
 * Exit codes: 0 AI marking found in every input, 1 not detected in at least
 * one, 2 inconclusive, 3 error.
 *
 * @module cli/verify
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

const USAGE = `Usage: ihub verify [options] <file|-> [...]

Check files or text for the AI markings iHub Apps applies (EU AI Act Art. 50):
C2PA manifests, TrustMark image watermarks, IPTC/XMP metadata, signed iHub
export manifests and text signposts. Nothing is uploaded.

Options:
  --json                 print the results as JSON
  --report <file>        write the (signed, when run in an installation) report(s) to a file
  --trust-anchor <pem>   trust signers chaining to this PEM root (repeatable)
  --text-watermark       also run text-watermark detection (needs the installation's key groups)
  --sign                 sign the report with the installation certificate (inside an installation only)
  -h, --help             show this help

Exit codes: 0 marking found, 1 not detected, 2 inconclusive, 3 error.`;

function parseArgs(argv) {
  const opts = { json: false, report: null, anchors: [], textWatermark: false, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--report') opts.report = argv[++i];
    else if (a === '--trust-anchor') opts.anchors.push(argv[++i]);
    else if (a === '--text-watermark') opts.textWatermark = true;
    else if (a === '--sign') opts.sign = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.inputs.push(a);
  }
  return opts;
}

async function readInput(input) {
  if (input === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return { name: 'stdin', buffer: Buffer.concat(chunks) };
  }
  return { name: input, buffer: await fs.readFile(path.resolve(input)) };
}

function colorFor(verdict) {
  return verdict === 'ai-generated' ? GREEN : verdict === 'not-detected' ? YELLOW : RED;
}

function printResult(name, { result }) {
  const c = colorFor(result.verdict);
  console.log(
    `\n${BOLD}${name}${NC}  ${DIM}${result.content.kind}, ${result.content.mimeType}, ${result.content.size} bytes${NC}`
  );
  console.log(`  ${c}${BOLD}${result.verdict}${NC}  ${result.summary}`);
  for (const t of result.techniques) {
    const mark = t.skipped
      ? `${DIM}skipped${NC}`
      : t.found
        ? t.valid === false
          ? `${RED}invalid${NC}`
          : `${GREEN}found${NC}`
        : `${DIM}none${NC}`;
    const trust =
      t.found && t.trusted
        ? ' (trusted)'
        : t.found && t.trusted === false
          ? ' (untrusted signer)'
          : '';
    console.log(`  - ${t.label}: ${mark}${trust}${t.detail ? ` ${DIM}— ${t.detail}${NC}` : ''}`);
  }
  console.log(`  ${DIM}sha256 ${result.content.sha256}${NC}`);
}

/**
 * Run the CLI.
 * @param {string[]} argv - arguments after `verify`
 * @returns {Promise<number>} exit code
 */
export async function runVerifyCLI(argv = []) {
  const opts = parseArgs(argv);
  if (opts.help || opts.inputs.length === 0) {
    console.log(USAGE);
    return opts.help ? 0 : 3;
  }
  // Quiet the server logger: this is a command-line tool.
  const { setLogLevel } = await import('../utils/logger.js');
  setLogLevel('error');
  // Signing needs this installation's encryption key; never create one here.
  let sign = false;
  if (opts.sign) {
    const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
    try {
      await fs.access(tokenStorageService.keyFilePath);
      await tokenStorageService.initializeEncryptionKey();
      sign = true;
    } catch {
      console.error(
        `${YELLOW}warning:${NC} no installation encryption key found; the report is not signed`
      );
    }
  }
  const { verifyContent } = await import('../services/provenance/detection/DetectionService.js');
  const anchors = [];
  for (const file of opts.anchors) anchors.push(await fs.readFile(path.resolve(file), 'utf8'));

  const outputs = [];
  let exit = 0;
  for (const input of opts.inputs) {
    try {
      const { name, buffer } = await readInput(input);
      const outcome = await verifyContent(
        { buffer },
        { canUseTextDetection: opts.textWatermark, trustAnchors: anchors, sign }
      );
      outputs.push({ input: name, ...outcome });
      if (!opts.json) printResult(name, outcome);
      const code =
        outcome.result.verdict === 'ai-generated'
          ? 0
          : outcome.result.verdict === 'not-detected'
            ? 1
            : 2;
      exit = Math.max(exit, code);
    } catch (error) {
      outputs.push({ input, error: error.message });
      if (!opts.json) console.error(`${RED}error:${NC} ${input}: ${error.message}`);
      exit = 3;
    }
  }
  if (opts.json) console.log(JSON.stringify(outputs, null, 2));
  if (opts.report) {
    await fs.writeFile(path.resolve(opts.report), `${JSON.stringify(outputs, null, 2)}\n`);
    if (!opts.json) console.log(`\nReport written to ${opts.report}`);
  }
  return exit;
}

// `node server/cli/verify.js <file>` (npm run verify -- <file>)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runVerifyCLI(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      console.error(error);
      process.exit(3);
    }
  );
}
