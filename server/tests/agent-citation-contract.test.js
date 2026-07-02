// Plain-node test (node server/tests/agent-citation-contract.test.js).
//
// Citation-contract change (run wf-exec-78d4c018: the synthesizer cited sparse
// ledger indices up to [575] over a 52-entry reference list). Root: the ledger
// was pre-numbered [1..N], so the model copied those numbers instead of owning
// a contiguous scheme. Fix: _formatCitations renders an UNNUMBERED pool, and the
// synthesizer prompt tells the model to assign its OWN contiguous [1..M]
// numbering that its References section must match exactly.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

// ---- _formatCitations: UNNUMBERED + deduped by normalized URL ----
{
  const e = new PromptNodeExecutor();
  const state = {
    data: {
      _citations: [
        { url: 'https://x.com/a', title: 'A' },
        { url: 'https://www.x.com/a/', title: 'A-dup' }, // variant of #1
        { url: 'https://y.com/b', title: 'B' }
      ]
    }
  };
  const out = e._formatCitations(state);
  check('no pre-assigned [N] index in the pool', !/\[\d+\]/.test(out), out);
  check('renders as a bullet list', /^- /m.test(out));
  check(
    'dedupes URL variants (2 unique not 3)',
    out.split('\n').filter(l => l.startsWith('- ')).length === 2,
    out
  );
  check('empty citations → empty string', e._formatCitations({ data: {} }) === '');
}

// ---- Prompt contract: self-numbering language in BOTH copies ----
const normalize = s =>
  String(s)
    .replace(/['"]\s*\+\s*['"]/g, '')
    .replace(/\s+/g, ' ');
const SELF_NUMBER = /(assign|your own).{0,40}(contiguous|numbering)|contiguous.{0,30}from\s*\[?1/i;
const NO_OLD_LEDGER = /citations-ledger url supports a claim/i; // the old decoupled contract

function checkContract(text, where) {
  const t = normalize(text);
  check(`${where}: instructs self-assigned contiguous numbering`, SELF_NUMBER.test(t));
  check(`${where}: dropped the old "cite ledger index" contract`, !NO_OLD_LEDGER.test(t));
}

const serializer = readFileSync(
  path.join(root, 'server/agents/profile/profileWorkflowSerializer.js'),
  'utf8'
);
checkContract(serializer, 'serializer synthesizer');

const phased = JSON.parse(
  readFileSync(path.join(root, 'server/defaults/workflows/claude-style-agent-phased.json'), 'utf8')
);
const synth = phased.nodes.find(n => n.id === 'synthesize');
const synthSys =
  typeof synth.config.system === 'object' ? synth.config.system.en : synth.config.system;
const synthPrompt =
  typeof synth.config.prompt === 'object' ? synth.config.prompt.en : synth.config.prompt;
checkContract(`${synthSys}\n${synthPrompt}`, 'phased synthesize node');
check(
  'phased prompt no longer calls it a pre-numbered "ledger ... for inline [N]"',
  !/ledger \(URLs the agent consulted — use for inline \[N\]\)/.test(synthPrompt)
);

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
