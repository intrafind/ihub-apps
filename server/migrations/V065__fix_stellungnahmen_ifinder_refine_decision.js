export const version = '065';
export const description = 'fix_stellungnahmen_ifinder_refine_decision';

// Existing installs already have contents/workflows/stellungnahmen-review-ifinder.json
// on disk (gitignored runtime data), so the fixed server/defaults copy does NOT
// reach them via performInitialSetup. This migration patches the refine-decision
// referee node in place to fix a dead-end/loop:
//
//   1. Routing resilience — when the LLM decision is unparseable (a truncated
//      structured-output response becomes a raw string, so `.done` is undefined),
//      the old `e-refine-done` edge (done === true || iters >= max) did not match
//      AND the `needs-more` edge did not match → the run silently completed right
//      after the search. The new `done !== false || …` makes any non-false /
//      unparseable decision proceed to the document loop.
//   2. Disable thinking on this fast JSON referee — gemini-flash-latest (a moving
//      alias now backed by an unbounded-thinking model, budget:-1) spent ~40s and
//      looped its reason field into a truncated response. Thinking off makes it
//      fast and terse. (Requires per-node thinking support; a no-op on providers
//      without thinking.)
//   3. Cap the output budget so a runaway reason truncates fast (~1-2s) and the
//      routing fix proceeds, instead of filling a huge buffer. Only lowers a
//      pathologically-large cap; small/tuned values are left alone.
//   4. Terse, no-repeat reason hint.
//
// All steps are idempotent and match exact known-old values, so admin
// customizations and already-fixed installs (fresh installs seeded from the fixed
// defaults) are left untouched.

const WF = 'workflows/stellungnahmen-review-ifinder.json';

const OLD_DONE_EXPR =
  '$.data._refineDecision.done === true || $.data._searchIterations >= $.data._maxSearchIterations';
const NEW_DONE_EXPR =
  '$.data._refineDecision.done !== false || $.data._searchIterations >= $.data._maxSearchIterations';

const REASON_HINTS = [
  {
    old: '"reason": "<one sentence>"',
    new: '"reason": "<one short sentence, max 25 words — never repeat yourself>"'
  },
  {
    old: '"reason": "<ein Satz>"',
    new: '"reason": "<ein kurzer Satz, max. 25 Wörter — niemals wiederholen>"'
  }
];

const MAX_TOKENS = 1024;

export async function precondition(ctx) {
  return await ctx.fileExists(WF);
}

export async function up(ctx) {
  const wf = await ctx.readJson(WF);
  if (!wf || !Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
    ctx.warn(`${WF} missing nodes/edges; skipping`);
    return;
  }

  let changed = false;

  // 1. Routing resilience — only replace the exact known-bad expression.
  for (const edge of wf.edges) {
    if (edge?.id === 'e-refine-done' && edge?.condition?.expression === OLD_DONE_EXPR) {
      edge.condition.expression = NEW_DONE_EXPR;
      changed = true;
    }
  }

  const refine = wf.nodes.find(n => n?.id === 'refine-decision');
  if (refine && refine.config && typeof refine.config === 'object') {
    // 2. Disable thinking (only if the node has no thinking block yet).
    if (refine.config.thinking === undefined) {
      refine.config.thinking = { enabled: false };
      changed = true;
    }

    // 3. Cap an oversized output budget.
    if (typeof refine.config.maxTokens === 'number' && refine.config.maxTokens > MAX_TOKENS) {
      refine.config.maxTokens = MAX_TOKENS;
      changed = true;
    }

    // 4. Terse, no-repeat reason hint (replace exact old placeholders).
    if (refine.config.prompt && typeof refine.config.prompt === 'object') {
      for (const lang of Object.keys(refine.config.prompt)) {
        const text = refine.config.prompt[lang];
        if (typeof text !== 'string') continue;
        let next = text;
        for (const { old, new: repl } of REASON_HINTS) next = next.replace(old, repl);
        if (next !== text) {
          refine.config.prompt[lang] = next;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    await ctx.writeJson(WF, wf);
    ctx.log(
      'Patched stellungnahmen-review-ifinder refine-decision (routing, thinking, maxTokens, reason hint)'
    );
  } else {
    ctx.log('stellungnahmen-review-ifinder refine-decision already up to date; no changes');
  }
}
