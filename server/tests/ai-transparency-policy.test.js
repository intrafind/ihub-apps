/**
 * EU AI Act transparency (#2563): shared helpers, the marking policy, the
 * installation-record rules (strip on export, ignore on import, admin-only
 * stamps) and the unmarked-model gate.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, setConfig } from './helpers/aiTransparencyEnv.js';

const shared = await import('../../shared/aiTransparency.js');
const { getInstallationId } = await import('../services/provenance/installation.js');
const { evaluateTextMarking, validDisclosureOptOut } =
  await import('../services/provenance/markingPolicy.js');
const records = await import('../services/provenance/records.js');
const { publicAppView, aiTransparencyClientConfig } =
  await import('../services/provenance/clientConfig.js');

after(cleanup);

const LONG = 'word '.repeat(400);
const req = { user: { id: 'admin1', name: 'Ada Admin', groups: ['admins'] }, headers: {} };

describe('shared/aiTransparency', () => {
  it('resolves defaults and keeps stored values', () => {
    const cfg = shared.resolveAiTransparency({ detection: { access: 'public' }, images: {} });
    assert.equal(cfg.detection.access, 'public');
    assert.equal(cfg.detection.log.enabled, true);
    assert.equal(cfg.images.c2pa, true);
    assert.equal(cfg.interactionDisclosure.enabled, true);
    assert.deepEqual(cfg.dismissals, []);
  });

  it('normalises model marking', () => {
    assert.equal(shared.normalizeContentMarking({}).text.kind, 'none');
    assert.equal(
      shared.normalizeContentMarking({ contentMarking: { textWatermark: 'upstream:google' } }).text
        .vendor,
      'google'
    );
    const vllm = shared.normalizeContentMarking({
      contentMarking: { textWatermark: { scheme: 'vllm-gumbel', keyGroup: 'acme' } }
    });
    assert.deepEqual(vllm.text, {
      kind: 'scheme',
      scheme: 'vllm-gumbel',
      keyGroup: 'acme',
      perRequest: false
    });
    assert.equal(
      shared.normalizeContentMarking({ modelType: 'transcription' }).text.kind,
      'not-applicable'
    );
    assert.equal(shared.isTextMarked({ contentMarking: { textWatermark: 'none' } }), false);
  });

  it('strips installation records from apps, models and platform', () => {
    const app = {
      id: 'a',
      aiTransparency: {
        sensitive: 'legal',
        disclosureOptOut: { reason: 'x' },
        exemption: { type: 'b2bTechnical' }
      }
    };
    const stripped = shared.stripInstallationRecords('app', app);
    assert.deepEqual(stripped.aiTransparency, { sensitive: 'legal' });
    assert.ok(app.aiTransparency.disclosureOptOut, 'input is not modified');
    assert.equal(
      shared.stripInstallationRecords('app', { id: 'b', aiTransparency: { disclosureOptOut: {} } })
        .aiTransparency,
      undefined
    );
    const model = shared.stripInstallationRecords('model', {
      id: 'm',
      contentMarking: { textWatermark: 'none', acknowledgement: { justification: 'x' } }
    });
    assert.deepEqual(model.contentMarking, { textWatermark: 'none' });
    const platform = shared.stripInstallationRecords('platform', {
      aiTransparency: { dismissals: [{}], detection: { access: 'public', experts: [{}] } }
    });
    assert.equal(platform.aiTransparency.dismissals, undefined);
    assert.deepEqual(platform.aiTransparency.detection, { access: 'public' });
    assert.equal(shared.hasInstallationRecords('app', app), true);
    assert.equal(shared.hasInstallationRecords('app', stripped), false);
  });

  it('estimates tokens and the 200-token threshold', () => {
    assert.equal(shared.requiresTextWatermark('short answer', {}), false);
    assert.equal(shared.requiresTextWatermark(LONG, {}), true);
    assert.equal(shared.watermarkEmbedsAtTemperature(0), false);
    assert.equal(shared.watermarkEmbedsAtTemperature(0.7), true);
  });
});

describe('marking policy', () => {
  const cfg = shared.resolveAiTransparency({});

  it('flags long text from an unmarked model, even when acknowledged', () => {
    const model = {
      id: 'claude',
      contentMarking: {
        textWatermark: 'none',
        acknowledgement: {
          installationId: getInstallationId(),
          justification: 'known gap',
          acknowledgedAt: 'x',
          acknowledgedBy: 'a'
        }
      }
    };
    const r = evaluateTextMarking({ content: LONG, model, cfg });
    assert.equal(r.status, 'unmarked');
    assert.equal(r.conforming, false);
    assert.equal(r.reason, 'model-unmarked');
  });

  it('does not require marking for short text', () => {
    const r = evaluateTextMarking({ content: 'Hi', model: {}, cfg });
    assert.equal(r.status, 'not-required');
    assert.equal(r.conforming, true);
  });

  it('counts vLLM and upstream marking, but not at temperature 0', () => {
    const vllm = { contentMarking: { textWatermark: { scheme: 'vllm-gumbel', keyGroup: 'k' } } };
    assert.equal(
      evaluateTextMarking({ content: LONG, model: vllm, temperature: 0.8, cfg }).status,
      'marked'
    );
    const cold = evaluateTextMarking({ content: LONG, model: vllm, temperature: 0, cfg });
    assert.equal(cold.status, 'unmarked');
    assert.equal(cold.reason, 'temperature-zero');
    const upstream = { contentMarking: { textWatermark: 'upstream:google' } };
    assert.equal(
      evaluateTextMarking({ content: LONG, model: upstream, cfg }).technique,
      'upstream:google'
    );
  });

  it('honours an exemption made on this installation only', () => {
    const exemption = {
      type: 'standardEditing',
      justification: 'translation app',
      installationId: getInstallationId()
    };
    const r = evaluateTextMarking({
      content: LONG,
      model: {},
      app: { aiTransparency: { exemption } },
      cfg
    });
    assert.equal(r.status, 'exempt');
    const foreign = { ...exemption, installationId: '00000000-0000-0000-0000-000000000000' };
    const r2 = evaluateTextMarking({
      content: LONG,
      model: {},
      app: { aiTransparency: { exemption: foreign } },
      cfg
    });
    assert.equal(r2.status, 'unmarked');
  });
});

describe('installation records', () => {
  it('ignores an opt-out that was made on another installation', () => {
    setConfig({ platform: {}, features: {} });
    const own = {
      aiTransparency: {
        disclosureOptOut: { installationId: getInstallationId(), reason: 'trained staff' }
      }
    };
    const foreign = {
      aiTransparency: { disclosureOptOut: { installationId: 'elsewhere', reason: 'copied' } }
    };
    assert.ok(validDisclosureOptOut(own));
    assert.equal(validDisclosureOptOut(foreign), null);
    assert.equal(publicAppView({ id: 'x', ...own }).aiTransparency.disclosure, false);
    assert.equal(publicAppView({ id: 'x', ...foreign }).aiTransparency.disclosure, true);
    const view = publicAppView({ id: 'x', ...own });
    assert.equal(
      view.aiTransparency.disclosureOptOut,
      undefined,
      'records never reach the chat client'
    );
  });

  it('keeps stored records on save and drops client-sent ones', () => {
    const stored = { aiTransparency: { disclosureOptOut: { reason: 'stored' } } };
    const incoming = {
      id: 'a',
      aiTransparency: { sensitive: 'health', disclosureOptOut: { reason: 'forged' } }
    };
    records.preserveStoredRecords('app', incoming, stored);
    assert.equal(incoming.aiTransparency.disclosureOptOut.reason, 'stored');
    assert.equal(incoming.aiTransparency.sensitive, 'health');
    const created = { id: 'b', aiTransparency: { exemption: { type: 'b2bTechnical' } } };
    records.preserveStoredRecords('app', created, null);
    assert.equal(created.aiTransparency, undefined, 'an imported app never brings records');
    const model = {
      id: 'm',
      contentMarking: { textWatermark: 'none', acknowledgement: { justification: 'forged' } }
    };
    records.preserveStoredRecords('model', model, null);
    assert.equal(model.contentMarking.acknowledgement, undefined);
  });

  it('requires a justification to enable an unmarked model', () => {
    const model = { id: 'claude', contentMarking: { textWatermark: 'none' } };
    assert.throws(
      () => records.applyUnmarkedModelGate([model], req, ''),
      records.UnmarkedModelError
    );
    assert.throws(
      () => records.applyUnmarkedModelGate([model], req, 'short'),
      records.UnmarkedModelError
    );
    const acked = records.applyUnmarkedModelGate(
      [model],
      req,
      'Needed for the pilot, gap documented'
    );
    assert.deepEqual(acked, ['claude']);
    const ack = model.contentMarking.acknowledgement;
    assert.equal(ack.acknowledgedBy, 'admin1');
    assert.equal(ack.acknowledgedByName, 'Ada Admin');
    assert.equal(ack.installationId, getInstallationId());
    assert.ok(ack.acknowledgedAt && ack.ihubVersion);
    // Already acknowledged here: no second justification needed.
    assert.deepEqual(records.applyUnmarkedModelGate([model], req, ''), []);
    // Marked models pass without one.
    assert.deepEqual(
      records.applyUnmarkedModelGate(
        [{ id: 'v', contentMarking: { textWatermark: 'upstream:google' } }],
        req,
        ''
      ),
      []
    );
  });
});

describe('client config', () => {
  it('turns every switch off when the feature is off', () => {
    setConfig({ features: { aiTransparency: false } });
    const cfg = aiTransparencyClientConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.interactionDisclosure.enabled, false);
    setConfig({ features: {} });
    assert.equal(aiTransparencyClientConfig().interactionDisclosure.enabled, true);
  });
});
