export const version = '031';
export const description = 'expand_telemetry_config';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Old shape was `{ enabled: false, logs: true }`. Expand it to the gen-ai
  // semantic-conventions structure without overwriting admin-set values.
  // setDefault is a no-op when a value is already present.
  ctx.setDefault(platform, 'telemetry.enabled', false);
  ctx.setDefault(platform, 'telemetry.provider', 'console');

  ctx.setDefault(
    platform,
    'telemetry.exporters.otlp.endpoint',
    '${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}'
  );
  ctx.setDefault(platform, 'telemetry.exporters.otlp.protocol', 'http/protobuf');
  ctx.setDefault(platform, 'telemetry.exporters.otlp.headers', {});
  ctx.setDefault(platform, 'telemetry.exporters.prometheus.port', 9464);
  ctx.setDefault(platform, 'telemetry.exporters.prometheus.host', '0.0.0.0');

  ctx.setDefault(platform, 'telemetry.spans.enabled', true);
  ctx.setDefault(platform, 'telemetry.spans.sampleRate', 1.0);
  ctx.setDefault(platform, 'telemetry.spans.includeOptInAttributes', false);

  ctx.setDefault(platform, 'telemetry.events.enabled', true);
  ctx.setDefault(platform, 'telemetry.events.includePrompts', false);
  ctx.setDefault(platform, 'telemetry.events.includeCompletions', false);
  ctx.setDefault(platform, 'telemetry.events.maxEventSize', 1024);

  ctx.setDefault(platform, 'telemetry.metrics.enabled', true);
  ctx.setDefault(platform, 'telemetry.metrics.exportInterval', 60000);

  ctx.setDefault(platform, 'telemetry.activitySummary.enabled', false);
  ctx.setDefault(platform, 'telemetry.activitySummary.intervalSeconds', 300);
  ctx.setDefault(platform, 'telemetry.activitySummary.windowMinutes', 5);

  ctx.setDefault(platform, 'telemetry.resource.service.name', 'ihub-apps');
  ctx.setDefault(platform, 'telemetry.resource.service.version', 'auto');
  ctx.setDefault(platform, 'telemetry.resource.deployment.environment', '${NODE_ENV:-production}');

  // Migrate the legacy shorthand `telemetry.logs: true|false` to the new object
  if (typeof platform.telemetry?.logs === 'boolean') {
    const wasEnabled = platform.telemetry.logs;
    platform.telemetry.logs = { enabled: wasEnabled, level: 'info' };
    ctx.log('Migrated telemetry.logs from boolean to object form');
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Expanded telemetry configuration with gen-ai conventions defaults');
}
