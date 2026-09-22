/**
 * Migration V117 — iAssistant turns that outlive 60 seconds, and a config key
 * that never did anything
 *
 * Symptom: an iAssistant conversation on the workspace profile was cancelled
 * after 60 seconds, mid-answer.
 *
 * 1. The stream idle ceiling was shorter than a workspace turn.
 *
 *    `llm.streamIdleTimeoutMs` (V095) bounds the gap between two chunks of a
 *    stream that has already started, so a provider that goes quiet without
 *    closing the stream fails in a minute instead of holding the turn for the
 *    whole-call deadline. For a text model emitting tokens steadily, a minute
 *    of silence really is a hang.
 *
 *    The iAssistant is not that shape. A workspace-profile turn assesses what
 *    it knows, plans, searches, reassesses and only then writes the answer,
 *    and iFinder's own per-turn budget (`maxDurationSeconds`) defaults to 90 s
 *    *before* response generation starts. The quiet stretch between the last
 *    status event and the first answer delta is ordinary work, and the 60 s
 *    ceiling read it as a dead stream.
 *
 *    The ceiling stays where it is for every other model; the iAssistant
 *    conversation models get 180 s of their own, which covers the 90 s budget
 *    plus a long generation and still fails well inside REQUEST_TIMEOUT.
 *
 * 2. `iAssistant.timeout` is removed, because nothing read it.
 *
 *    It was documented as "Request timeout in milliseconds for iAssistant API
 *    calls" and defaulted to 60000, so it is exactly what an administrator
 *    hitting the cancellation above would reach for — and raising it changed
 *    nothing, because the adapter goes through LLMClient, which never saw it.
 *    Leaving a plausible-looking dial that is not connected to anything costs
 *    more than removing it.
 *
 * 3. `iAssistant.defaultSearchProfile` is written out.
 *
 *    The fallback search profile was a literal buried in two places in the
 *    code. Seeding the value it already had makes platform.json an honest
 *    record of what is in force and gives administrators somewhere to change
 *    it.
 *
 * Nothing here overwrites a tuned value: a model that already carries a
 * `streamIdleTimeoutMs`, or an installation that already set a default search
 * profile, keeps what it has.
 */

export const version = '117';
export const description = 'iassistant_stream_ceiling_and_grounding';

/** Providers whose turns are agentic rather than token-steady. */
const IASSISTANT_PROVIDERS = new Set(['iassistant-conversation']);

/**
 * Headroom for one iAssistant turn: iFinder's 90 s reasoning budget, the
 * response generation that follows it, and margin for a slow corpus.
 */
const IASSISTANT_STREAM_IDLE_TIMEOUT_MS = 180000;

/** The value the shipped platform.json carried for the dead timeout key. */
const DEAD_TIMEOUT_DEFAULT = 60000;

/** The literal the code used as its fallback search profile. */
const DEFAULT_SEARCH_PROFILE = 'searchprofile-standard';

export async function up(ctx) {
  await raiseModelCeilings(ctx);
  await tidyPlatformConfig(ctx);
}

/**
 * Give every iAssistant conversation model its own idle ceiling.
 *
 * @param {object} ctx - migration context
 */
async function raiseModelCeilings(ctx) {
  const files = await ctx.listFiles('models', '*.json');
  let raised = 0;

  for (const file of files) {
    const path = `models/${file}`;
    let model;
    try {
      model = await ctx.readJson(path);
    } catch (error) {
      // A model file that does not parse is not this migration's to repair,
      // and throwing here would block every later migration on startup.
      ctx.warn(`Skipped ${path}: ${error.message}`);
      continue;
    }

    if (!IASSISTANT_PROVIDERS.has(model.provider)) continue;
    // An operator who already chose a ceiling knows their installation
    // better than this migration does. 0 is a deliberate choice too — it
    // disables the ceiling — so only an absent key is seeded.
    if (model.streamIdleTimeoutMs !== undefined) continue;

    model.streamIdleTimeoutMs = IASSISTANT_STREAM_IDLE_TIMEOUT_MS;
    await ctx.writeJson(path, model);
    raised += 1;
  }

  if (raised > 0) {
    ctx.log(
      `Set streamIdleTimeoutMs=${IASSISTANT_STREAM_IDLE_TIMEOUT_MS} ms on ${raised} iAssistant model(s)`
    );
  }
}

/**
 * Drop the dead timeout key and record the search-profile fallback.
 *
 * @param {object} ctx - migration context
 */
async function tidyPlatformConfig(ctx) {
  if (!(await ctx.fileExists('config/platform.json'))) return;

  const platform = await ctx.readJson('config/platform.json');
  if (!platform.iAssistant || typeof platform.iAssistant !== 'object') return;

  let changed = false;

  const timeout = platform.iAssistant.timeout;
  if (timeout !== undefined) {
    if (timeout !== DEAD_TIMEOUT_DEFAULT) {
      // Worth saying out loud: someone tuned this expecting it to do
      // something, and the number they chose is a hint about how long their
      // turns actually run.
      ctx.warn(
        `Removed iAssistant.timeout (${timeout} ms), which was never read. If iAssistant turns ` +
          `were being cancelled, the ceiling that applies is streamIdleTimeoutMs on the ` +
          `iassistant-conversation model, now ${IASSISTANT_STREAM_IDLE_TIMEOUT_MS} ms.`
      );
    }
    ctx.removeKey(platform, 'iAssistant.timeout');
    changed = true;
  }

  if (platform.iAssistant.defaultSearchProfile === undefined) {
    ctx.setDefault(platform, 'iAssistant.defaultSearchProfile', DEFAULT_SEARCH_PROFILE);
    changed = true;
  }

  if (changed) {
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Tidied the iAssistant platform config');
  }
}
