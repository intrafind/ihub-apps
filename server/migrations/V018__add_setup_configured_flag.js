export const version = '018';
export const description = 'add_setup_configured_flag';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // For existing installs: auto-detect if already configured (has providers with API keys or env vars).
  // New installs get false so the setup wizard is shown on first launch.
  let alreadyConfigured = false;

  try {
    if (await ctx.fileExists('config/providers.json')) {
      const { providers = [] } = await ctx.readJson('config/providers.json');
      const LLM_PROVIDER_IDS = ['openai', 'anthropic', 'google', 'mistral'];
      alreadyConfigured = providers
        .filter(p => LLM_PROVIDER_IDS.includes(p.id))
        .some(p => p.apiKey);
    }
  } catch {
    // If we can't read providers, fall through to env var check
  }

  if (!alreadyConfigured) {
    const envVars = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY'];
    alreadyConfigured = envVars.some(v => process.env[v]);
  }

  ctx.setDefault(platform, 'setup.configured', alreadyConfigured);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Added setup.configured = ${alreadyConfigured}`);
}
