/**
 * Migration V151 — dictation through transcription models
 *
 * Dictation (the chat's microphone button) could stream to exactly one server
 * backend: the vLLM endpoint in `platform.speech.realtime`, picked as the
 * `vllm-realtime` service. Dictation now names a transcription model, as
 * recording and file transcription always did, so any of them — Voxtral on vLLM
 * or on Mistral, Gemini Transcribe Live, Gemini Transcribe — can take dictation,
 * and an endpoint is configured in one place: on its model.
 *
 * This moves what `speech.realtime` held onto a model and repoints everything
 * that used it:
 *
 * 1. **The model.** A `vllm-realtime` model already pointing at the same
 *    endpoint (V077 seeded `voxtral-mini-realtime` from it) is reused.
 *    Otherwise one is written from the shipped Voxtral default with the
 *    endpoint, upstream model and key (still encrypted, as the models'
 *    `apiKey` accepts): as `voxtral-mini-realtime` when no such file exists,
 *    else as `voxtral-mini-realtime-dictation`. Only when the endpoint was in
 *    use — the platform default or an app picked `vllm-realtime` — or
 *    switched on; an unused, switched-off endpoint is dropped.
 * 2. **Enabled** when the endpoint was working: the bridge only serves enabled
 *    models.
 * 3. **Choices.** `speech.defaultService: "vllm-realtime"` becomes `"model"`
 *    with `speech.dictation.modelId`; an app's
 *    `settings.speechRecognition.service: "vllm-realtime"` becomes `"model"`
 *    with `modelId`.
 * 4. **Groups.** The platform backend needed no model permission; a model
 *    does. When the endpoint was working, a group gets the model if it could
 *    dictate through it — it reaches an app that used `vllm-realtime`, or one
 *    that followed a `vllm-realtime` platform default — and, counting what it
 *    inherits, grants neither `*` nor the model already. Parents come first,
 *    so a group that inherits the grant is not granted again. On a shipped
 *    setup that is only `anonymous`: every other group inherits a `*`.
 * 5. **Cleanup.** `speech.realtime` keeps only its connection limits;
 *    `enabled`, `url`, `model` and `apiKey` go.
 *
 * Idempotent: the model is found again by its endpoint until platform.json —
 * written last — no longer carries it. Anything it cannot read (an app or
 * model file, the shipped default) fails the migration before it writes, so
 * the endpoint is not dropped and the migration runs again on the next start,
 * once the file is fixed.
 */

export const version = '151';
export const description = 'dictation_via_transcription_models';

const RETIRED_SERVICE = 'vllm-realtime';
const DEFAULT_MODEL_ID = 'voxtral-mini-realtime';
const DICTATION_MODEL_ID = 'voxtral-mini-realtime-dictation';
const ENDPOINT_FIELDS = ['enabled', 'url', 'model', 'apiKey'];

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/** Every JSON file of a directory. An unreadable one fails the migration. */
async function readJsonFiles(ctx, directory) {
  if (!(await ctx.fileExists(directory))) return [];
  const names = await ctx.listFiles(directory, '*.json');
  const files = [];
  for (const name of names) {
    const path = `${directory}/${name}`;
    try {
      files.push({ path, data: await ctx.readJson(path) });
    } catch (err) {
      throw new Error(`Cannot read ${path} (${err.message}); fix it and restart`);
    }
  }
  return files;
}

/** The `vllm-realtime` model already serving the endpoint, if any. */
function findEndpointModel(models, endpoint) {
  const matches = models.filter(
    ({ data }) =>
      data?.provider === RETIRED_SERVICE &&
      (data.url || '').trim() === endpoint.url &&
      (!endpoint.model || data.modelId === endpoint.model)
  );
  return matches.find(({ data }) => data.id === DEFAULT_MODEL_ID) || matches[0] || null;
}

/** The model dictation moves to, reused or written from the shipped default; its id. */
async function resolveDictationModel(ctx, models, endpoint, working) {
  if (endpoint.url) {
    const existing = findEndpointModel(models, endpoint);
    if (existing) {
      const changes = [];
      if (!existing.data.apiKey && endpoint.apiKey) {
        existing.data.apiKey = endpoint.apiKey;
        changes.push('took the endpoint key');
      }
      if (working && existing.data.enabled === false) {
        existing.data.enabled = true;
        changes.push('enabled');
      }
      if (changes.length > 0) {
        await ctx.writeJson(existing.path, existing.data);
        ctx.log(`${existing.path}: ${changes.join(', ')} — dictation used its endpoint`);
      }
      return existing.data.id;
    }
  } else if (await ctx.fileExists(`models/${DEFAULT_MODEL_ID}.json`)) {
    // Nothing configured to carry over: the shipped model is as good as any.
    return DEFAULT_MODEL_ID;
  }

  let model;
  try {
    model = await ctx.readDefaultJson(`models/${DEFAULT_MODEL_ID}.json`);
  } catch (err) {
    throw new Error(`Cannot read the shipped ${DEFAULT_MODEL_ID} model (${err.message})`);
  }
  if (await ctx.fileExists(`models/${DEFAULT_MODEL_ID}.json`)) {
    // Never overwrite a model file an admin has.
    let id = DICTATION_MODEL_ID;
    for (let n = 2; await ctx.fileExists(`models/${id}.json`); n++)
      id = `${DICTATION_MODEL_ID}-${n}`;
    model.id = id;
    model.name = { en: 'Voxtral Mini (Dictation)', de: 'Voxtral Mini (Diktat)' };
  }
  if (endpoint.url) model.url = endpoint.url;
  if (endpoint.model) model.modelId = endpoint.model;
  if (endpoint.apiKey) model.apiKey = endpoint.apiKey;
  model.enabled = working;
  await ctx.writeJson(`models/${model.id}.json`, model);
  ctx.log(`Wrote models/${model.id}.json (enabled=${model.enabled}) from speech.realtime`);
  return model.id;
}

/**
 * A group's grants of one kind (`apps`, `models`) including what it inherits —
 * what its members get, since permissions are the union over a user's groups
 * and their ancestors.
 */
function effectiveGrants(groups, groupId, kind, seen = new Set()) {
  if (seen.has(groupId) || !groups[groupId]) return new Set();
  seen.add(groupId);
  const group = groups[groupId];
  const grants = new Set(Array.isArray(group.permissions?.[kind]) ? group.permissions[kind] : []);
  for (const parent of Array.isArray(group.inherits) ? group.inherits : []) {
    for (const id of effectiveGrants(groups, parent, kind, seen)) grants.add(id);
  }
  return grants;
}

/** How many ancestors deep a group sits, so parents can be handled first. */
function inheritanceDepth(groups, groupId, seen = new Set()) {
  if (seen.has(groupId) || !groups[groupId]) return 0;
  seen.add(groupId);
  const parents = Array.isArray(groups[groupId].inherits) ? groups[groupId].inherits : [];
  return parents.reduce(
    (deepest, parent) => Math.max(deepest, 1 + inheritanceDepth(groups, parent, new Set(seen))),
    0
  );
}

/**
 * Grant the model to every group whose members could dictate through the
 * retired backend: those reaching one of `dictatingAppIds`.
 */
async function grantModelToGroups(ctx, modelId, dictatingAppIds) {
  if (dictatingAppIds.size === 0 || !(await ctx.fileExists('config/groups.json'))) return;
  const config = await ctx.readJson('config/groups.json');
  const groups = config?.groups;
  if (!groups || typeof groups !== 'object') return;

  const couldDictate = groupId => {
    const apps = effectiveGrants(groups, groupId, 'apps');
    return apps.has('*') || [...dictatingAppIds].some(id => apps.has(id));
  };
  const order = Object.keys(groups).sort(
    (a, b) => inheritanceDepth(groups, a) - inheritanceDepth(groups, b)
  );
  const granted = [];
  for (const groupId of order) {
    if (!couldDictate(groupId)) continue;
    const models = effectiveGrants(groups, groupId, 'models');
    if (models.has('*') || models.has(modelId)) continue;
    const group = groups[groupId];
    // The schema defaults a missing list to none at all.
    if (!group.permissions || typeof group.permissions !== 'object') group.permissions = {};
    if (!Array.isArray(group.permissions.models)) group.permissions.models = [];
    group.permissions.models.push(modelId);
    granted.push(groupId);
  }
  if (granted.length === 0) return;
  await ctx.writeJson('config/groups.json', config);
  ctx.log(`Granted ${modelId} to groups that could dictate before: ${granted.join(', ')}`);
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const speech = platform.speech && typeof platform.speech === 'object' ? platform.speech : null;
  const realtime = speech?.realtime && typeof speech.realtime === 'object' ? speech.realtime : {};
  const endpoint = {
    url: typeof realtime.url === 'string' ? realtime.url.trim() : '',
    model: typeof realtime.model === 'string' ? realtime.model : '',
    apiKey: typeof realtime.apiKey === 'string' ? realtime.apiKey : ''
  };
  // What the bridge treated as a configured backend.
  const working = realtime.enabled !== false && !!endpoint.url;

  const allApps = await readJsonFiles(ctx, 'apps');
  const serviceOf = app => app.data?.settings?.speechRecognition?.service;
  const apps = allApps.filter(app => serviceOf(app) === RETIRED_SERVICE);
  const defaultUsesIt = speech?.defaultService === RETIRED_SERVICE;
  const inUse = defaultUsesIt || apps.length > 0;
  // Every app whose microphone streamed to the endpoint: its own choice, or the
  // platform default it followed.
  const dictatingAppIds = new Set(
    allApps
      .filter(app => {
        const service = serviceOf(app);
        return (
          service === RETIRED_SERVICE || (defaultUsesIt && (!service || service === 'default'))
        );
      })
      .map(app => app.data?.id || app.path.replace(/^apps\//, '').replace(/\.json$/, ''))
  );

  let modelId = null;
  if (inUse || working) {
    modelId = await resolveDictationModel(
      ctx,
      await readJsonFiles(ctx, 'models'),
      endpoint,
      working
    );
  }

  for (const app of apps) {
    const recognition = app.data.settings.speechRecognition;
    recognition.service = 'model';
    recognition.modelId = modelId;
    await ctx.writeJson(app.path, app.data);
    ctx.log(`${app.path}: dictation via model ${modelId}`);
  }

  if (modelId && working) await grantModelToGroups(ctx, modelId, dictatingAppIds);

  if (speech) {
    if (defaultUsesIt) speech.defaultService = 'model';
    ctx.setDefault(platform, 'speech.dictation.modelId', '');
    if (defaultUsesIt) speech.dictation.modelId = modelId;

    if (speech.realtime && typeof speech.realtime === 'object') {
      for (const field of ENDPOINT_FIELDS) delete speech.realtime[field];
      if (Object.keys(speech.realtime).length === 0) delete speech.realtime;
    }
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    modelId
      ? `Dictation now uses transcription models; speech.realtime moved to ${modelId}`
      : 'Dictation now uses transcription models; speech.realtime had nothing to move'
  );
}
