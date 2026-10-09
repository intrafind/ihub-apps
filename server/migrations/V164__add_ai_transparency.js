export const version = '164';
export const description = 'add_ai_transparency';

/**
 * EU AI Act Art. 50 transparency (issue #2563).
 *
 * 1. Seeds `platform.aiTransparency` with the shipped defaults, key by key, so
 *    every value an admin already set stays as it is. The defaults are
 *    compliant out of the box: disclosure, image marking, signing, provenance
 *    records and detection all start on.
 * 2. Gives every installed model a `contentMarking` block where it has none
 *    (the marking capability registry). Cloud models are unmarked unless the
 *    vendor documents marking; Gemini image models carry Google SynthID. An
 *    admin who knows better changes the block; this never overwrites one.
 *
 * The values are written out here rather than imported from
 * `shared/aiTransparency.js`: a migration is frozen once it ran, and a later
 * change to the shared defaults must not change what this one did.
 */
export const AI_TRANSPARENCY_DEFAULTS = Object.freeze({
  'provider.legalEntity': '',
  'provider.contact': '',
  'provider.address': '',
  'provider.role': 'provider',
  'editorialResponsibility.contact': '',
  'editorialResponsibility.policyUrl': '',
  'termsOfService.markRemovalClause': false,
  'termsOfService.url': '',
  'interactionDisclosure.enabled': true,
  'interactionDisclosure.firstTurnNotice': true,
  'interactionDisclosure.persistentBadge': true,
  'interactionDisclosure.guardrail': true,
  'interactionDisclosure.reminderInterval': 5,
  'labels.messageBadge': true,
  'labels.euIcon': 'optional',
  'labels.exportLabel': true,
  'labels.outbound': true,
  'images.c2pa': true,
  'images.watermark': 'trustmark',
  'images.watermarkStrength': 0.95,
  'images.trustmarkModelPath': '',
  'images.xmp': true,
  'text.watermarkMinTokens': 200,
  'text.signpost.exports': true,
  'text.signpost.clipboard': false,
  'text.strictMode': false,
  'provenance.enabled': true,
  'provenance.retentionDays': 365,
  'exports.sign': true,
  'signing.enabled': true,
  'signing.tsaUrl': '',
  'signing.trustedAnchors': [],
  'signing.organization': '',
  'signing.commonName': '',
  'detection.enabled': true,
  'detection.access': 'authenticated',
  'detection.rateLimit.windowMinutes': 15,
  'detection.rateLimit.limit': 30,
  'detection.zeroRetention': true,
  'detection.experts': [],
  'detection.log.enabled': true,
  'detection.log.retentionDays': 90,
  installationUrl: '',
  dismissals: []
});

function isImageModel(model) {
  return (
    model?.supportsImageGeneration === true ||
    (model?.imageGeneration !== null && typeof model?.imageGeneration === 'object')
  );
}

/** The `contentMarking` block a model without one gets. */
export function defaultMarkingFor(model) {
  const marking = { textWatermark: 'none' };
  if (model?.provider === 'google' && isImageModel(model)) {
    marking.imageWatermark = 'upstream:synthid';
  }
  return marking;
}

export async function precondition(ctx) {
  return (await ctx.fileExists('config/platform.json')) || (await ctx.fileExists('models'));
}

export async function up(ctx) {
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    let added = 0;
    for (const [key, value] of Object.entries(AI_TRANSPARENCY_DEFAULTS)) {
      const copy = Array.isArray(value) ? [...value] : value;
      if (ctx.setDefault(platform, `aiTransparency.${key}`, copy)) added++;
    }
    if (added > 0) {
      await ctx.writeJson('config/platform.json', platform);
      ctx.log(`Added ${added} aiTransparency defaults to platform.json`);
    }
  }

  if (await ctx.fileExists('models')) {
    for (const file of await ctx.listFiles('models', '*.json')) {
      const path = `models/${file}`;
      let model;
      try {
        model = await ctx.readJson(path);
      } catch (error) {
        ctx.warn(`Skipped ${path}: ${error.message}`);
        continue;
      }
      if (!model || typeof model !== 'object' || model.contentMarking !== undefined) continue;
      if (model.modelType === 'transcription') continue;
      model.contentMarking = defaultMarkingFor(model);
      await ctx.writeJson(path, model);
      ctx.log(`${path}: added contentMarking ${JSON.stringify(model.contentMarking)}`);
    }
  }
}
