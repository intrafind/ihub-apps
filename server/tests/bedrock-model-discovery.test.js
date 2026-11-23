// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Bedrock model listing for the "Connect a model provider" wizard: the region
 * picks the control-plane host, the key is sent as Bearer token, models that
 * need a cross-region inference profile are offered under the profile id of
 * the region's geography, and AWS's refusals become the readable causes the
 * wizard explains.
 *
 * The fetch is injected (an AWS client double), so nothing here touches the network.
 * The proxy and SSL whitelist path of the real fetch is covered in
 * bedrock-discovery-transport.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bedrockRejection,
  discoverBedrockModels,
  indexInferenceProfiles,
  normalizeBedrockModel,
  resolveBedrockEndpoints
} from '../services/BedrockModelDiscovery.js';
import { ModelDiscoveryError } from '../services/ModelEndpointDiscovery.js';
import {
  bedrockEndpointRegion,
  bedrockProfilePrefix,
  hasBedrockProfilePrefix,
  isValidBedrockRegion
} from '../../shared/bedrockRegions.js';

const ARN = id => `arn:aws:bedrock:eu-central-1::foundation-model/${id}`;

/** Trimmed `ListFoundationModels` answer of eu-central-1. */
const FOUNDATION_MODELS = {
  modelSummaries: [
    {
      modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
      modelName: 'Claude Sonnet 4',
      providerName: 'Anthropic',
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
      responseStreamingSupported: true,
      inferenceTypesSupported: ['INFERENCE_PROFILE'],
      modelLifecycle: { status: 'ACTIVE' }
    },
    {
      modelId: 'mistral.mistral-large-2402-v1:0',
      modelName: 'Mistral Large (24.02)',
      providerName: 'Mistral AI',
      inputModalities: ['TEXT'],
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['ON_DEMAND'],
      modelLifecycle: { status: 'LEGACY', endOfLifeTime: '2026-12-31T00:00:00Z' }
    },
    {
      // Provisioned throughput only: never callable on demand.
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0:28k',
      modelName: 'Claude 3 Sonnet',
      providerName: 'Anthropic',
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['PROVISIONED']
    },
    {
      modelId: 'amazon.titan-embed-text-v2:0',
      modelName: 'Titan Text Embeddings V2',
      providerName: 'Amazon',
      inputModalities: ['TEXT'],
      outputModalities: ['EMBEDDING'],
      inferenceTypesSupported: ['ON_DEMAND']
    },
    {
      // Needs a profile, but the region serves none for it.
      modelId: 'meta.llama4-scout-17b-instruct-v1:0',
      modelName: 'Llama 4 Scout 17B Instruct',
      providerName: 'Meta',
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['INFERENCE_PROFILE']
    }
  ]
};

/** Trimmed `ListInferenceProfiles` answer, in two pages. */
const PROFILE_PAGES = [
  {
    inferenceProfileSummaries: [
      {
        inferenceProfileId: 'global.anthropic.claude-sonnet-4-20250514-v1:0',
        inferenceProfileName: 'Global Claude Sonnet 4',
        status: 'ACTIVE',
        type: 'SYSTEM_DEFINED',
        models: [{ modelArn: ARN('anthropic.claude-sonnet-4-20250514-v1:0') }]
      }
    ],
    nextToken: 'page-2'
  },
  {
    inferenceProfileSummaries: [
      {
        inferenceProfileId: 'eu.anthropic.claude-sonnet-4-20250514-v1:0',
        inferenceProfileName: 'EU Claude Sonnet 4',
        status: 'ACTIVE',
        type: 'SYSTEM_DEFINED',
        models: [
          { modelArn: ARN('anthropic.claude-sonnet-4-20250514-v1:0') },
          {
            modelArn:
              'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0'
          }
        ]
      }
    ]
  }
];

function jsonResponse(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => lower[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

/**
 * Stand-in for the AWS Bedrock control plane: answers the two listing calls
 * and records every request.
 */
function fakeBedrock({ models = FOUNDATION_MODELS, profiles = PROFILE_PAGES, fail } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (fail) return fail(url);
    if (url.includes('/foundation-models')) return jsonResponse(200, models);
    if (url.includes('/inference-profiles')) {
      if (profiles instanceof Error) throw profiles;
      if (typeof profiles === 'function') return profiles(url);
      const page = new URL(url).searchParams.get('nextToken') === 'page-2' ? 1 : 0;
      return jsonResponse(200, profiles[page]);
    }
    return jsonResponse(404, {});
  };
  return { fetch, calls };
}

test('regions: AWS region codes and global are valid, anything else is refused', () => {
  for (const region of ['eu-central-1', 'us-east-1', 'ap-southeast-2', 'us-gov-west-1', 'global']) {
    assert.equal(isValidBedrockRegion(region), true, region);
  }
  for (const region of [
    '',
    'EU-CENTRAL-1',
    'eu-central',
    'apac-northeast-1',
    'evil.com/x',
    'eu-central-1.evil.com',
    'eu-central-1#',
    null,
    42
  ]) {
    assert.equal(isValidBedrockRegion(region), false, String(region));
  }
});

test('regions: global is called through the default source region and maps to global. profiles', () => {
  assert.equal(bedrockEndpointRegion('global'), 'eu-central-1');
  assert.equal(bedrockEndpointRegion('us-west-2'), 'us-west-2');
  assert.equal(bedrockProfilePrefix('eu-west-1'), 'eu.');
  assert.equal(bedrockProfilePrefix('ap-northeast-1'), 'apac.');
  assert.equal(bedrockProfilePrefix('global'), 'global.');
  assert.equal(hasBedrockProfilePrefix('jp.anthropic.claude-sonnet-4-v1:0'), true);
  assert.equal(hasBedrockProfilePrefix('anthropic.claude-sonnet-4-v1:0'), false);
});

test('resolveBedrockEndpoints builds the control-plane URLs of the region', () => {
  assert.deepEqual(resolveBedrockEndpoints('eu-west-3'), {
    baseUrl: 'https://bedrock.eu-west-3.amazonaws.com',
    modelsUrl: 'https://bedrock.eu-west-3.amazonaws.com/foundation-models',
    profilesUrl: 'https://bedrock.eu-west-3.amazonaws.com/inference-profiles',
    endpointRegion: 'eu-west-3'
  });
});

test('discoverBedrockModels lists the region with the key as Bearer token, reading every profile page', async () => {
  const { fetch, calls } = fakeBedrock();
  const result = await discoverBedrockModels(
    { region: 'eu-central-1', apiKey: ' bedrock-key ' },
    { fetch }
  );

  assert.equal(calls[0].url, 'https://bedrock.eu-central-1.amazonaws.com/foundation-models');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer bedrock-key');
  assert.equal(calls[0].init.redirect, 'manual');
  const profileCalls = calls.filter(c => c.url.includes('/inference-profiles'));
  assert.equal(profileCalls.length, 2);
  assert.match(profileCalls[0].url, /type=SYSTEM_DEFINED/);
  assert.match(profileCalls[1].url, /nextToken=page-2/);

  assert.equal(result.provider, 'bedrock');
  assert.equal(result.region, 'eu-central-1');
  assert.equal(result.baseUrl, 'https://bedrock.eu-central-1.amazonaws.com');
  assert.equal(result.azure, false);

  const byFoundation = Object.fromEntries(result.models.map(m => [m.foundationModelId, m]));
  // Profile-only model: the EU profile of the region's geography, not the global one.
  assert.equal(
    byFoundation['anthropic.claude-sonnet-4-20250514-v1:0'].id,
    'eu.anthropic.claude-sonnet-4-20250514-v1:0'
  );
  assert.equal(byFoundation['anthropic.claude-sonnet-4-20250514-v1:0'].name, 'EU Claude Sonnet 4');
  assert.equal(byFoundation['anthropic.claude-sonnet-4-20250514-v1:0'].supportsVision, true);
  assert.equal(byFoundation['anthropic.claude-sonnet-4-20250514-v1:0'].unsupported, undefined);
  // On-demand model: its own id, end of life passed on.
  assert.equal(
    byFoundation['mistral.mistral-large-2402-v1:0'].id,
    'mistral.mistral-large-2402-v1:0'
  );
  assert.equal(byFoundation['mistral.mistral-large-2402-v1:0'].ownedBy, 'Mistral AI');
  assert.equal(byFoundation['mistral.mistral-large-2402-v1:0'].endOfLife, '2026-12-31T00:00:00Z');
  // Provisioned-only variants are not listed at all.
  assert.equal(byFoundation['anthropic.claude-3-sonnet-20240229-v1:0:28k'], undefined);
  // Embeddings cannot run through Converse; a profile-only model without a profile cannot be called.
  assert.equal(byFoundation['amazon.titan-embed-text-v2:0'].type, 'embedding');
  assert.equal(byFoundation['amazon.titan-embed-text-v2:0'].unsupported, true);
  assert.equal(byFoundation['meta.llama4-scout-17b-instruct-v1:0'].unsupported, true);
  // No model carries a URL: the adapter builds it from the region.
  assert.ok(result.models.every(m => m.url === undefined));
});

test('discoverBedrockModels with global offers only models with a global profile', async () => {
  const { fetch, calls } = fakeBedrock();
  const result = await discoverBedrockModels({ region: 'global', apiKey: 'k' }, { fetch });
  assert.equal(calls[0].url, 'https://bedrock.eu-central-1.amazonaws.com/foundation-models');
  const callable = result.models.filter(m => !m.unsupported).map(m => m.id);
  assert.deepEqual(callable, ['global.anthropic.claude-sonnet-4-20250514-v1:0']);
});

test('discoverBedrockModels falls back to the region prefix when the profiles cannot be listed', async () => {
  const { fetch } = fakeBedrock({
    profiles: () =>
      jsonResponse(
        403,
        { message: 'not authorized to perform: bedrock:ListInferenceProfiles' },
        {
          'x-amzn-ErrorType': 'AccessDeniedException:'
        }
      )
  });
  const result = await discoverBedrockModels({ region: 'eu-west-1', apiKey: 'k' }, { fetch });
  const sonnet = result.models.find(m =>
    m.foundationModelId.startsWith('anthropic.claude-sonnet-4')
  );
  assert.equal(sonnet.id, 'eu.anthropic.claude-sonnet-4-20250514-v1:0');
  assert.equal(sonnet.unsupported, undefined);
});

test('discoverBedrockModels refuses a value that is not a region before calling AWS', async () => {
  const { fetch, calls } = fakeBedrock();
  await assert.rejects(
    discoverBedrockModels({ region: 'evil.example.com/x', apiKey: 'k' }, { fetch }),
    err =>
      err instanceof ModelDiscoveryError && err.messageKey === 'invalidRegion' && err.status === 400
  );
  assert.equal(calls.length, 0);
});

test('an unknown key is "authenticationFailed", a key without permission "accessDenied"', async () => {
  const unknownKey = fakeBedrock({
    fail: () =>
      jsonResponse(
        403,
        { message: 'The security token included in the request is invalid.' },
        {
          'x-amzn-ErrorType': 'UnrecognizedClientException:http://internal.amazon.com/coral/'
        }
      )
  });
  await assert.rejects(
    discoverBedrockModels({ region: 'eu-central-1', apiKey: 'wrong' }, { fetch: unknownKey.fetch }),
    err =>
      err.messageKey === 'authenticationFailed' &&
      err.status === 502 &&
      err.details.upstreamStatus === 403 &&
      err.details.host === 'bedrock.eu-central-1.amazonaws.com'
  );

  const noPermission = fakeBedrock({
    fail: () =>
      jsonResponse(
        403,
        { message: 'User is not authorized to perform: bedrock:ListFoundationModels' },
        { 'x-amzn-ErrorType': 'AccessDeniedException:' }
      )
  });
  await assert.rejects(
    discoverBedrockModels({ region: 'eu-central-1', apiKey: 'k' }, { fetch: noPermission.fetch }),
    err => err.messageKey === 'accessDenied' && /ListFoundationModels/.test(err.details.remediation)
  );
});

test("without a key AWS's 403 asks for one", async () => {
  const { fetch, calls } = fakeBedrock({
    fail: () => jsonResponse(403, { message: 'Missing Authentication Token' })
  });
  await assert.rejects(
    discoverBedrockModels({ region: 'eu-central-1' }, { fetch }),
    err => err.messageKey === 'apiKeyRequired'
  );
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('a region without a Bedrock endpoint says so', async () => {
  const { fetch } = fakeBedrock({
    fail: () => {
      const err = new Error('getaddrinfo ENOTFOUND bedrock.xx-nowhere-9.amazonaws.com');
      err.code = 'ENOTFOUND';
      throw err;
    }
  });
  await assert.rejects(
    discoverBedrockModels({ region: 'xx-nowhere-9', apiKey: 'k' }, { fetch }),
    err => err.messageKey === 'hostNotFound' && /xx-nowhere-9/.test(err.details.remediation)
  );
});

test('an answer without modelSummaries is not a model list', async () => {
  const { fetch } = fakeBedrock({ models: { message: 'hello' } });
  await assert.rejects(
    discoverBedrockModels({ region: 'eu-central-1', apiKey: 'k' }, { fetch }),
    err => err.messageKey === 'invalidResponse'
  );
});

test('bedrockRejection leaves other statuses to the generic mapping', async () => {
  assert.equal(await bedrockRejection(jsonResponse(404, {})), null);
  assert.equal(await bedrockRejection(jsonResponse(500, {})), null);
});

test('normalizeBedrockModel and indexInferenceProfiles ignore inactive profiles and broken entries', () => {
  const profiles = indexInferenceProfiles([
    { inferenceProfileId: 'eu.x.y', status: 'DISABLED', models: [{ modelArn: ARN('x.y') }] },
    { inferenceProfileId: '', models: [{ modelArn: ARN('x.y') }] }
  ]);
  assert.equal(profiles.size, 0);
  assert.equal(normalizeBedrockModel(null, { region: 'eu-central-1', profiles }), null);
  assert.equal(
    normalizeBedrockModel({ modelName: 'x' }, { region: 'eu-central-1', profiles }),
    null
  );
});

test('adapter: a set but invalid region is a configuration error, never a fallback', async () => {
  const { default: BedrockAdapter } = await import('../adapters/bedrock.js');
  const { isLLMError, LLM_ERROR_CODES } = await import('../services/loop/contracts/errors.js');
  const saved = {
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION
  };
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  const refused = region => err =>
    isLLMError(err) &&
    err.code === LLM_ERROR_CODES.INVALID_REQUEST &&
    err.providerCode === 'BEDROCK_REGION_INVALID' &&
    err.message.includes(`"${region}"`) &&
    err.message.includes('config.region of the model');
  try {
    assert.equal(BedrockAdapter.resolveRegion({ config: { region: 'us-west-2' } }), 'us-west-2');
    // The legacy placeholder, a typo and a host name: refused, not sent to eu-central-1.
    for (const region of ['apac-northeast-1', 'us-east1', 'evil.com/x']) {
      assert.throws(() => BedrockAdapter.resolveRegion({ config: { region } }), refused(region));
    }
    // Nor to a region the next source names.
    process.env.AWS_REGION = 'eu-north-1';
    assert.throws(
      () => BedrockAdapter.resolveRegion({ config: { region: 'us-east1' } }),
      refused('us-east1')
    );
    // Only an empty value is skipped.
    assert.equal(BedrockAdapter.resolveRegion({ config: {} }), 'eu-north-1');
    assert.equal(BedrockAdapter.resolveRegion({ config: { region: '' } }), 'eu-north-1');
    assert.equal(BedrockAdapter.resolveRegion({ config: { region: '  ' } }), 'eu-north-1');
    // An invalid environment value is refused too, naming the variable.
    process.env.AWS_REGION = 'Frankfurt';
    assert.throws(
      () => BedrockAdapter.resolveRegion({ config: {} }),
      err => err.providerCode === 'BEDROCK_REGION_INVALID' && /AWS_REGION/.test(err.message)
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('adapter: an invalid region fails the request before anything is sent', async () => {
  const { default: BedrockAdapter } = await import('../adapters/bedrock.js');
  await assert.rejects(
    BedrockAdapter.createCompletionRequest(
      {
        id: 'claude',
        provider: 'bedrock',
        modelId: 'anthropic.claude',
        config: { region: 'us-east1' }
      },
      [{ role: 'user', content: 'hi' }],
      'key',
      { stream: false }
    ),
    err => err.providerCode === 'BEDROCK_REGION_INVALID'
  );
});

test('adapter: a listed profile id of any geography is sent as it is', async () => {
  const { default: BedrockAdapter } = await import('../adapters/bedrock.js');
  assert.equal(
    BedrockAdapter.resolveBedrockModelId(
      { modelId: 'jp.anthropic.claude-sonnet-4-20250514-v1:0' },
      'ap-northeast-1'
    ),
    'jp.anthropic.claude-sonnet-4-20250514-v1:0'
  );
  assert.equal(
    BedrockAdapter.resolveBedrockModelId(
      { modelId: 'anthropic.claude-sonnet-4-20250514-v1:0' },
      'eu-central-1'
    ),
    'eu.anthropic.claude-sonnet-4-20250514-v1:0'
  );
});
