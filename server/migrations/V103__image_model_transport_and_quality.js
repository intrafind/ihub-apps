/**
 * Migration V103 — Room for image models, and the image quality key they use
 *
 * Two fixes for the same models, both of which surfaced as one chat error:
 * "The google endpoint for model gemini-3-pro-image could not be reached".
 *
 * 1. The connect ceiling was too tight.
 *
 *    `llm.connectTimeoutMs` (V095) bounds the phase before a provider's first
 *    response byte, so an endpoint that blackholes the connection fails in
 *    seconds instead of hanging on the five-minute whole-call deadline. That
 *    inference holds for a streamed text model, whose headers are flushed as
 *    soon as the provider accepts the request. It does not hold for Google's
 *    image models: nothing comes back until the render is ready, so
 *    time-to-first-byte *is* generation time there, and a 4K image at
 *    `thinkingLevel: high` needs far longer than ten seconds. Every Nano
 *    Banana Pro request therefore failed as an unreachable endpoint.
 *
 *    The installation-wide default moves 10 s → 30 s, which also covers a
 *    gateway that authenticates before forwarding, and image models get
 *    `connectTimeoutMs: 60000` of their own. Both stay well under
 *    REQUEST_TIMEOUT, so a genuinely unreachable host still fails fast rather
 *    than holding a browser connection for five minutes.
 *
 * 2. `imageGeneration.imageSize` is no longer a valid key.
 *
 *    Image size used to be configured in Google's own units (`1K`/`2K`/`4K`)
 *    and passed through. It is now configured as `quality` (`Low`/`Medium`/
 *    `High`) and the Google adapter translates that into the provider's
 *    `imageConfig.imageSize` — the same three values, but a provider-neutral
 *    name the other image providers can reuse. The model schema is `.strict()`,
 *    so a config still carrying `imageSize` fails validation outright:
 *    "Property imageSize is not allowed". Nothing converted the stored configs
 *    when the key changed, so this does it.
 *
 * Both steps only touch what they recognise. An operator who already raised
 * `connectTimeoutMs` keeps their number, and a config that already carries
 * `quality` keeps it — a stray `imageSize` alongside one is dropped, since it
 * is the key that fails validation and `quality` is what the adapter reads.
 */

export const version = '103';
export const description = 'image_model_transport_and_quality';

/** The value V095 seeded. A stored ceiling still equal to it was never tuned. */
const SUPERSEDED_CONNECT_TIMEOUT_MS = 10000;

/** The new installation-wide default. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30000;

/** What an image model gets, because its first byte waits on the render. */
const IMAGE_MODEL_CONNECT_TIMEOUT_MS = 60000;

/**
 * Google's image-size units mapped onto the quality levels that replaced them.
 * The adapter's resolution table is uniform across aspect ratios, so the
 * conversion needs no ratio context.
 */
const IMAGE_SIZE_TO_QUALITY = {
  '1K': 'Low',
  '2K': 'Medium',
  '4K': 'High'
};

export async function up(ctx) {
  await raiseInstallationCeiling(ctx);
  await updateModels(ctx);
}

/**
 * Move the platform-wide ceiling to 30 s, but only where it is still the 10 s
 * V095 seeded. An absent key is seeded too: the code default moved with it, so
 * writing the number keeps platform.json an honest record of what is in force.
 *
 * @param {object} ctx - migration context
 */
async function raiseInstallationCeiling(ctx) {
  if (!(await ctx.fileExists('config/platform.json'))) return;

  const platform = await ctx.readJson('config/platform.json');
  const current = platform.llm?.connectTimeoutMs;

  if (current === DEFAULT_CONNECT_TIMEOUT_MS) {
    // A fresh install copies the shipped platform.json, which already carries
    // the new value, so this is the common path rather than a conflict.
    return;
  }

  if (current !== undefined && current !== SUPERSEDED_CONNECT_TIMEOUT_MS) {
    ctx.log(
      `Kept llm.connectTimeoutMs at ${current} ms (tuned for this installation, not the shipped default)`
    );
    return;
  }

  // `setDefault` creates `llm` when it is absent but will not replace the
  // superseded 10000, so assign afterwards to cover both cases.
  ctx.setDefault(platform, 'llm.connectTimeoutMs', DEFAULT_CONNECT_TIMEOUT_MS);
  platform.llm.connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Raised llm.connectTimeoutMs to ${DEFAULT_CONNECT_TIMEOUT_MS} ms`);
}

/**
 * Give every image-generation model its own 60 s ceiling and convert any
 * leftover `imageGeneration.imageSize` into `quality`.
 *
 * @param {object} ctx - migration context
 */
async function updateModels(ctx) {
  const files = await ctx.listFiles('models', '*.json');
  let ceilings = 0;
  let converted = 0;

  for (const file of files) {
    const path = `models/${file}`;
    let model;
    try {
      model = await ctx.readJson(path);
    } catch (error) {
      // A model file that does not parse is not this migration's to repair,
      // and failing here would block every later migration on startup.
      ctx.warn(`Skipped ${path}: ${error.message}`);
      continue;
    }

    let changed = false;

    if (model.supportsImageGeneration === true && model.connectTimeoutMs === undefined) {
      model.connectTimeoutMs = IMAGE_MODEL_CONNECT_TIMEOUT_MS;
      ceilings += 1;
      changed = true;
    }

    if (model.imageGeneration && 'imageSize' in model.imageGeneration) {
      const mapped = IMAGE_SIZE_TO_QUALITY[model.imageGeneration.imageSize];
      if (model.imageGeneration.quality === undefined && mapped) {
        model.imageGeneration.quality = mapped;
      } else if (model.imageGeneration.quality === undefined) {
        ctx.warn(
          `${path}: unrecognised imageGeneration.imageSize ` +
            `"${model.imageGeneration.imageSize}" — dropping it and leaving quality to the default`
        );
      }
      delete model.imageGeneration.imageSize;
      converted += 1;
      changed = true;
    }

    if (changed) await ctx.writeJson(path, model);
  }

  if (ceilings > 0) {
    ctx.log(
      `Set connectTimeoutMs=${IMAGE_MODEL_CONNECT_TIMEOUT_MS} on ${ceilings} image-generation model(s)`
    );
  }
  if (converted > 0) {
    ctx.log(`Converted imageGeneration.imageSize to quality on ${converted} model(s)`);
  }
}
