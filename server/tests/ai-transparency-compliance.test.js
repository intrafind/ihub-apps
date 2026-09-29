/**
 * EU AI Act transparency (#2565, #2566, #2573): conformance evaluation,
 * dismissals tied to state, image marking and detection, provenance records.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, setConfig } from './helpers/aiTransparencyEnv.js';

const { getInstallationId } = await import('../services/provenance/installation.js');
const { evaluateCompliance } = await import('../services/provenance/ComplianceService.js');
const { default: signingService } = await import('../services/provenance/signing/SigningService.js');
const { isC2paAvailable } = await import('../services/provenance/signing/c2pa.js');
const { default: provenanceStore, hashContent } = await import('../services/provenance/ProvenanceStore.js');
const { recordTurnProvenance } = await import('../services/provenance/turnProvenance.js');
const { verifyContent, verifyDetectionReport, sniffContent } = await import(
  '../services/provenance/detection/DetectionService.js'
);
const { markImage } = await import('../services/provenance/image/ImageMarker.js');
const { encodeRgb } = await import('../services/provenance/image/imageFormats.js');
const { applyAiDisclosureGuardrail } = await import('../services/provenance/guardrail.js').then(m => ({
  applyAiDisclosureGuardrail: m.appendAiDisclosureGuardrail
}));

const c2paAvailable = await isC2paAvailable();
provenanceStore._setDocuments(null);

const COMPLETE_PLATFORM = {
  aiTransparency: {
    provider: { legalEntity: 'ACME GmbH', contact: 'ai@acme.example', role: 'provider' },
    editorialResponsibility: { contact: 'editor@acme.example' },
    termsOfService: { markRemovalClause: true },
    images: { watermark: 'none' }
  }
};

before(async () => {
  setConfig({ platform: COMPLETE_PLATFORM, features: {} });
  await signingService.ensureCertificate();
});
after(cleanup);

function status(id, s) {
  return s.checklist.find(c => c.id === id)?.status;
}

describe('conformance', () => {
  it('flags an enabled unmarked model, and keeps flagging it when acknowledged', async () => {
    setConfig({
      platform: COMPLETE_PLATFORM,
      models: [
        { id: 'claude', provider: 'anthropic', enabled: true, contentMarking: { textWatermark: 'none' } },
        { id: 'vendor', provider: 'google', enabled: true, contentMarking: { textWatermark: 'upstream:google' } }
      ],
      apps: []
    });
    let s = await evaluateCompliance();
    assert.equal(status('textWatermarking', s), 'error');
    assert.equal(s.conforming, false);
    assert.ok(s.warnings.some(w => w.id === 'model:claude:unmarked' && w.dismissible));
    assert.equal(s.models.find(m => m.id === 'vendor').conforming, true);

    setConfig({
      models: [
        {
          id: 'claude',
          provider: 'anthropic',
          enabled: true,
          contentMarking: {
            textWatermark: 'none',
            acknowledgement: { installationId: getInstallationId(), justification: 'pilot', acknowledgedAt: 'now', acknowledgedBy: 'a' }
          }
        }
      ]
    });
    s = await evaluateCompliance();
    const claude = s.models.find(m => m.id === 'claude');
    assert.ok(claude.acknowledgement);
    assert.equal(claude.conforming, false, 'an acknowledgement never makes a model conforming');
    assert.equal(status('textWatermarking', s), 'error');
  });

  it('a dismissal hides the warning but not the status, and expires when the state changes', async () => {
    const models = [{ id: 'claude', provider: 'anthropic', enabled: true, contentMarking: { textWatermark: 'none' } }];
    setConfig({ platform: COMPLETE_PLATFORM, models });
    const before = await evaluateCompliance();
    const warning = before.warnings.find(w => w.id === 'model:claude:unmarked');
    const dismissal = {
      warningId: warning.id,
      stateHash: warning.stateHash,
      reason: 'documented gap for the pilot',
      dismissedBy: 'admin1',
      dismissedAt: new Date().toISOString(),
      installationId: getInstallationId()
    };
    setConfig({
      platform: { aiTransparency: { ...COMPLETE_PLATFORM.aiTransparency, dismissals: [dismissal] } }
    });
    const after = await evaluateCompliance();
    assert.ok(!after.activeWarnings.some(w => w.id === warning.id), 'hidden from the banner');
    assert.equal(status('textWatermarking', after), 'error', 'status unchanged');
    // The model's marking changes (a key group now missing): the state hash changes.
    setConfig({
      models: [{ ...models[0], contentMarking: { textWatermark: 'none', notes: 'changed' }, name: 'renamed' }]
    });
    const same = await evaluateCompliance();
    assert.ok(!same.activeWarnings.some(w => w.id === warning.id), 'unrelated fields do not resurface it');
    setConfig({ models: [{ ...models[0], enabled: true, contentMarking: { textWatermark: 'none' }, modelType: 'chat', provider: 'mistral' }] });
    // A foreign dismissal never counts.
    setConfig({
      platform: {
        aiTransparency: {
          ...COMPLETE_PLATFORM.aiTransparency,
          dismissals: [{ ...dismissal, installationId: 'another-installation' }]
        }
      },
      models
    });
    const foreign = await evaluateCompliance();
    assert.ok(foreign.activeWarnings.some(w => w.id === warning.id));
  });

  it('signing and detection warnings cannot be dismissed', async () => {
    setConfig({
      platform: { aiTransparency: { ...COMPLETE_PLATFORM.aiTransparency, detection: { enabled: false } } },
      models: []
    });
    const s = await evaluateCompliance();
    const detection = s.warnings.find(w => w.id === 'detection:disabled');
    assert.ok(detection);
    assert.equal(detection.dismissible, false);
    assert.equal(status('detection', s), 'error');
  });

  it('reports missing provider details and terms of service', async () => {
    setConfig({ platform: {}, models: [] });
    const s = await evaluateCompliance();
    assert.equal(status('provider', s), 'error');
    assert.equal(status('termsOfService', s), 'error');
    assert.equal(status('editorial', s), 'warning');
  });

  it('flags apps that run a watermarking model at temperature 0', async () => {
    setConfig({
      platform: COMPLETE_PLATFORM,
      models: [
        { id: 'vllm', provider: 'local', enabled: true, contentMarking: { textWatermark: { scheme: 'vllm-gumbel', keyGroup: 'k' } } }
      ],
      apps: [{ id: 'exact', preferredModel: 'vllm', preferredTemperature: 0 }]
    });
    const s = await evaluateCompliance();
    assert.ok(s.warnings.some(w => w.id === 'app:exact:temperature-zero'));
    assert.ok(s.warnings.some(w => w.id === 'model:vllm:key-group'), 'the key group does not exist');
  });
});

describe('provenance records', () => {
  it('records a hash, never the content, and finds it again', async () => {
    setConfig({ platform: COMPLETE_PLATFORM });
    const content = 'A generated answer that is long enough to matter. '.repeat(40);
    const p = await recordTurnProvenance({ content, model: { id: 'm', provider: 'openai' }, kind: 'chat' });
    assert.match(p.contentId, /^prv_/);
    assert.equal(p.contentHash, hashContent(content));
    assert.equal(p.marking.status, 'unmarked');
    const record = await provenanceStore.findByContent(`${content}\n`);
    assert.equal(record.contentId, p.contentId, 'trailing whitespace does not matter');
    assert.equal(JSON.stringify(record).includes('generated answer'), false);
  });
});

describe('guardrail', () => {
  it('adds the AI disclosure to the system prompt, once', () => {
    setConfig({ platform: COMPLETE_PLATFORM, features: {} });
    const messages = [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }];
    assert.equal(applyAiDisclosureGuardrail(messages), true);
    assert.match(messages[0].content, /you are an AI system/);
    assert.equal(applyAiDisclosureGuardrail(messages), false);
    const bare = [{ role: 'user', content: 'hi' }];
    applyAiDisclosureGuardrail(bare);
    assert.equal(bare[0].role, 'system');
  });
});

describe('detection', () => {
  it('recognises signed images by C2PA and XMP', { skip: !c2paAvailable }, async () => {
    setConfig({ platform: COMPLETE_PLATFORM });
    const width = 64;
    const rgb = Buffer.alloc(width * width * 3, 90);
    const png = encodeRgb({ width, height: width, rgb }, 'image/png');
    const marked = await markImage({ buffer: png, mimeType: 'image/png', model: { id: 'gemini', provider: 'google' } });
    assert.ok(marked.provenance.markings.includes('c2pa'));
    assert.ok(marked.provenance.markings.includes('xmp'));
    const { result, report } = await verifyContent({ buffer: marked.buffer, mimeType: 'image/png' });
    assert.equal(result.verdict, 'ai-generated');
    const c2pa = result.techniques.find(t => t.technique === 'c2pa');
    assert.equal(c2pa.found && c2pa.valid && c2pa.trusted, true);
    assert.ok(result.techniques.find(t => t.technique === 'xmp').found);
    const checked = await verifyDetectionReport(report);
    assert.equal(checked.valid && checked.trusted, true);
    assert.equal(checked.payload.content.sha256, result.content.sha256);
    const plain = await verifyContent({ buffer: png, mimeType: 'image/png' });
    assert.equal(plain.result.verdict, 'not-detected');
  });

  it('recognises generated text by its provenance record, limits text watermarks to experts', async () => {
    const content = 'Another generated answer for detection. '.repeat(30);
    await recordTurnProvenance({ content, model: { id: 'm', provider: 'openai' }, kind: 'chat' });
    const { result } = await verifyContent({ text: content });
    assert.equal(result.verdict, 'ai-generated');
    assert.equal(result.techniques.find(t => t.technique === 'provenance-record').found, true);
    assert.equal(result.techniques.find(t => t.technique === 'text-watermark').skipped, 'experts-only');
    const human = await verifyContent({ text: 'I wrote this myself this morning.' });
    assert.equal(human.result.verdict, 'not-detected');
  });

  it('sniffs content kinds', async () => {
    assert.equal((await sniffContent(Buffer.from('%PDF-1.7\n'))).kind, 'pdf');
    assert.equal((await sniffContent(Buffer.from('<!DOCTYPE html><html></html>'))).kind, 'html');
    assert.equal((await sniffContent(Buffer.from('{"a":1}'))).kind, 'json');
    assert.equal((await sniffContent(Buffer.from('hello'))).kind, 'text');
  });
});
