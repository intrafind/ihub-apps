/**
 * Migration V034 — Add AWS Bedrock provider
 *
 * Registers the `bedrock` provider in config/providers.json for existing
 * installations so the AWS Bedrock adapter can be selected when configuring
 * a model. Fresh installs receive this automatically via
 * server/defaults/config/providers.json.
 */

export const version = '034';
export const description = 'Add AWS Bedrock provider';

export async function precondition(ctx) {
  return await ctx.fileExists('config/providers.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/providers.json');

  if (!Array.isArray(config.providers)) {
    config.providers = [];
  }

  const added = ctx.addIfMissing(
    config.providers,
    {
      id: 'bedrock',
      name: { en: 'AWS Bedrock', de: 'AWS Bedrock' },
      description: {
        en: 'AWS Bedrock foundation models via the Converse API',
        de: 'AWS Bedrock Foundation Models über die Converse-API'
      },
      enabled: true,
      category: 'llm'
    },
    'id'
  );

  if (added) {
    await ctx.writeJson('config/providers.json', config);
    ctx.log('Added bedrock provider');
  } else {
    ctx.log('bedrock provider already present — skipping');
  }
}
