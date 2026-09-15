/**
 * Migration V103 — Seed the durable-chat artifact settings
 *
 * An artifact is anything a chat turn produced that is content in its own
 * right. Today that is a generated image; the name is deliberately wider than
 * that, because the same store is where a document, a chart or a file a tool
 * wrote belongs, and because "everything this conversation produced" is meant
 * to be listable in one place.
 *
 * A generated image used to live only in the browser tab that asked for it:
 * `sessionStorage` cannot hold megabytes, so the client stripped the payload
 * and the picture was gone the moment the user navigated away. With durable
 * chats on, the transcript survives and what the turn produced should survive
 * with it.
 *
 * The payloads are stored beside the transcript — one document per artifact,
 * fetched only when a viewer looks at one — rather than inside it, because a
 * transcript is a single document that every later turn of the chat reads,
 * re-serializes and re-hashes. The settings seeded here bound what that
 * costs:
 *
 * - `chats.storeArtifacts`         — master switch. `false` keeps transcripts
 *                                    and drops what the turns produced, which
 *                                    is exactly the behaviour an installation
 *                                    has today.
 * - `chats.maxArtifactBytes`       — largest single artifact stored, in bytes
 *                                    of base64; <= 0 removes the cap. 10 MB is
 *                                    roughly a 7.5 MB file, past anything the
 *                                    image models return.
 * - `chats.maxArtifactsPerMessage` — artifacts one answer stores; <= 0 removes
 *                                    the cap.
 *
 * Every value is the built-in default, so an upgrade changes nothing on its
 * own — the keys just become visible and editable in Admin → Platform
 * Configuration instead of appearing out of nowhere later. Installations that
 * already set one of them keep their value: each key is filled in on its own.
 *
 * `maxMessagesPerChat` is not re-seeded here; V097 owns it.
 */

export const version = '103';
export const description = 'Add durable-chat artifact storage defaults';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'chats.storeArtifacts', true);
  ctx.setDefault(platform, 'chats.maxArtifactBytes', 10485760);
  ctx.setDefault(platform, 'chats.maxArtifactsPerMessage', 8);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Added durable-chat artifact defaults (storeArtifacts=true, maxArtifactBytes=10485760, ' +
      'maxArtifactsPerMessage=8)'
  );
}
