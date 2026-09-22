/**
 * Migration V106 — Seed the artifact store's settings
 *
 * An **artifact** is content a run produced that is worth keeping in its own
 * right. Today that is the image a chat turn generated; a workflow's report
 * and an agent's output are the same kind of thing and share the same store,
 * which is why this is a `platform.artifacts` block of its own rather than a
 * few more keys under `chats`.
 *
 * A generated image used to live only in the browser tab that asked for it:
 * `sessionStorage` cannot hold megabytes, so the client stripped the payload
 * and the picture was gone the moment the user navigated away.
 *
 * Payloads are stored one document per artifact, keyed by the scope that owns
 * them, and fetched only when a viewer looks at one — never inlined in the
 * producer's own documents, because a chat transcript and a workflow state
 * document are single documents that get re-read, re-serialized and re-hashed
 * on every step. The settings seeded here bound what that costs:
 *
 * - `artifacts.enabled`     — master switch for every producer. `false` stores
 *                             no artifacts at all, which is exactly the
 *                             behaviour an installation has today.
 * - `artifacts.maxBytes`    — largest single artifact, in bytes of base64;
 *                             <= 0 removes the cap. 10 MB is roughly a 7.5 MB
 *                             file, past anything the image models return.
 * - `artifacts.maxPerBatch` — artifacts one producer records in one go (one
 *                             chat answer, one workflow node); <= 0 removes
 *                             the cap.
 *
 * Every value is the built-in default, so an upgrade changes nothing on its
 * own — the block just becomes visible and editable in Admin → Platform
 * Configuration instead of appearing out of nowhere later. Installations that
 * already set one of these keep their value: each key is filled in on its own.
 */

export const version = '106';
export const description = 'Add artifact storage defaults';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'artifacts.enabled', true);
  ctx.setDefault(platform, 'artifacts.maxBytes', 10485760);
  ctx.setDefault(platform, 'artifacts.maxPerBatch', 8);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added artifact defaults (enabled=true, maxBytes=10485760, maxPerBatch=8)');
}
