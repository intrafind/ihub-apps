// Plain-node test (node server/tests/agent-synthesizer-anti-hallucination.test.js).
//
// Runs wf-exec-f33f80fc (Nelms) and wf-exec-8b36a2e7 (Stewart) were FAILED by
// the verifier for genuine hallucinations: an ALTERED quote (Stewart's "watched
// The Matrix" line rewritten to fit the pitch) and impossible FUTURE Gartner
// publication dates. The synthesizer (report composer) and task workers must be
// explicitly forbidden from altering quoted text or inventing dates/identifiers.
//
// This locks the guardrails into BOTH the canonical default prompt
// (profileWorkflowSerializer.js) AND the tracked phased workflow JSON (the live
// run uses the JSON's inline copy), so the two can't drift.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

// Guardrail signatures (case-insensitive). A prompt "has the guardrails" when it
// forbids altering quotes AND inventing dates. Text is normalized first so the
// regexes are robust to JS string-concatenation seams (`' + '` + newline) in the
// serializer source vs. the single-line escaped string in the workflow JSON.
const QUOTE_RULE = /(never|do not|don't).{0,60}(alter|fabricat|invent|paraphrase|change).{0,60}quot|quot.{0,60}(verbatim|exact)/i;
const DATE_RULE = /(never|do not|don't).{0,80}(invent|guess|fabricat|extrapolat).{0,40}(date|publication)|future.{0,40}date/i;
// Synthesis-discipline guardrails added after run wf-exec-c9907222, where the
// synthesizer's summary invented a "67% thundery showers" figure and attributed
// it to a source that said 41% light rain. The summary must not overstate the
// body, and every [N] must match what that source actually states.
const SUMMARY_RULE = /summary.{0,160}(must not|not).{0,40}(stronger|exceed|overstate|escalat|more confiden)/i;
const ATTRIBUTION_RULE = /attribut.{0,160}(never|not).{0,80}(figure|quote|percentage|claim|source)|never attribute/i;

// Join adjacent string literals (`'…' + '…'`) and collapse whitespace so prose
// that wraps across source lines reads as one continuous string.
const normalize = s =>
  String(s)
    .replace(/['"]\s*\+\s*['"]/g, '')
    .replace(/\s+/g, ' ');

function hasGuardrails(rawText, where) {
  const text = normalize(rawText);
  check(`${where}: forbids altering/fabricating quotes`, QUOTE_RULE.test(text), text ? '(present but no match)' : '(empty)');
  check(`${where}: forbids inventing/future dates`, DATE_RULE.test(text));
}

// Synthesizer-only: summary may not overstate the body, and attributions must
// match their source. (Task workers don't write a summary, so this is not
// asserted there.)
function hasSynthDiscipline(rawText, where) {
  const text = normalize(rawText);
  check(`${where}: summary must not overstate the body`, SUMMARY_RULE.test(text), text ? '(present but no match)' : '(empty)');
  check(`${where}: attributions must match their source`, ATTRIBUTION_RULE.test(text));
}

// 1. Canonical default in the serializer.
const serializerSrc = readFileSync(
  path.join(root, 'server/agents/profile/profileWorkflowSerializer.js'),
  'utf8'
);
hasGuardrails(serializerSrc, 'DEFAULT_SYNTHESIZER_SYSTEM (serializer)');
hasSynthDiscipline(serializerSrc, 'DEFAULT_SYNTHESIZER_SYSTEM (serializer)');

// 2. Tracked phased workflow's inline synthesize node prompt (what runs live).
const phased = JSON.parse(
  readFileSync(path.join(root, 'server/defaults/workflows/claude-style-agent-phased.json'), 'utf8')
);
const nodes = phased.nodes || phased.workflow?.nodes || [];
const synth = nodes.find(n => n.id === 'synthesize');
check('phased workflow has a synthesize node', !!synth);
const synthSys = synth && (typeof synth.config?.system === 'object' ? synth.config.system.en : synth.config?.system);
hasGuardrails(synthSys || '', 'phased synthesize node');
hasSynthDiscipline(synthSys || '', 'phased synthesize node');

// 3. The upstream task worker (taskTemplate.system) — where quotes/dates are
// first gathered — must carry the same integrity guard.
const plannerNode = nodes.find(n => n.config?.taskTemplate?.system);
const workerSys =
  plannerNode &&
  (typeof plannerNode.config.taskTemplate.system === 'object'
    ? plannerNode.config.taskTemplate.system.en
    : plannerNode.config.taskTemplate.system);
hasGuardrails(workerSys || '', 'phased task worker (taskTemplate)');

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
