// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Telemetry resource attributes on the current semantic conventions (#4008,
 * P3): `deployment.environment` is `deployment.environment.name`.
 *
 * `telemetry.resource` holds the attribute in two shapes, the flat key
 * (`"deployment.environment": …`) and the nested form V031 wrote through a
 * dotted path (`"deployment": { "environment": … }`). Both become the flat
 * `deployment.environment.name`; an admin's own value wins over the default.
 */
export const version = '268';
export const description = 'telemetry_semconv_resource';

const NEW_KEY = 'deployment.environment.name';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/platform.json');
  const resource = config.telemetry?.resource;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    ctx.log('No telemetry.resource; nothing to do');
    return;
  }

  const flat = resource['deployment.environment'];
  const nested =
    resource.deployment && typeof resource.deployment === 'object'
      ? resource.deployment.environment
      : undefined;
  const value = resource[NEW_KEY] ?? flat ?? nested;

  let changed = false;
  if (flat !== undefined) {
    delete resource['deployment.environment'];
    changed = true;
  }
  if (nested !== undefined) {
    delete resource.deployment.environment;
    if (Object.keys(resource.deployment).length === 0) delete resource.deployment;
    changed = true;
  }
  if (value !== undefined && resource[NEW_KEY] === undefined) {
    resource[NEW_KEY] = value;
    changed = true;
  }

  if (!changed) {
    ctx.log('telemetry.resource already uses deployment.environment.name');
    return;
  }
  await ctx.writeJson('config/platform.json', config);
  ctx.log('Renamed telemetry.resource deployment.environment to deployment.environment.name');
}
