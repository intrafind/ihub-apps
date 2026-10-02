/**
 * Detection of every marking technique iHub uses (CoP Measures 2.1, 2.3;
 * concept §8.4; issue #2573). One engine behind `/verify`, the admin
 * detection page and `ihub verify <file>`.
 *
 * Techniques, reported one by one so the result says *which* technique found
 * the mark:
 * - `c2pa`: signed C2PA manifest (images; PDFs signed by other tools)
 * - `trustmark`: invisible image watermark → content id → provenance record
 * - `xmp`: IPTC `DigitalSourceType` metadata
 * - `ihub-manifest`: signed iHub manifest of exports (PDF, OOXML, HTML, JSON)
 * - `text-signpost`: C2PA text wrapper with a signed signpost
 * - `text-watermark`: vLLM watermark via the key group's detector (approved
 *   experts and admins only, CoP 2.1.2)
 * - `provenance-record`: exact content/file hash known to this installation
 *
 * Zero retention (CoP 2.1.3): the submitted content lives only in memory for
 * the duration of the call; the detection log keeps metadata only.
 *
 * @module services/provenance/detection/DetectionService
 */
import JSZip from 'jszip';
import { inflateBudget, readZipEntry, zipEntries } from '../zipLimits.js';
import { getAppVersion } from '../../../utils/versionHelper.js';
import { DIGITAL_SOURCE_TYPES, estimateTokens } from '../../../../shared/aiTransparency.js';
import { getInstallationId, getInstallationUrl } from '../installation.js';
import signingService from '../signing/SigningService.js';
import { readAsset, C2PA_READABLE_TYPES } from '../signing/c2pa.js';
import { decodeImageWatermark } from '../image/ImageMarker.js';
import { readXmp, sniffImageType } from '../image/imageFormats.js';
import { verifyExportManifest } from '../export/ExportSigner.js';
import { verifyTextSignpost } from '../text/signpost.js';
import { detectTextWatermark } from '../watermark/TextWatermarkDetector.js';
import provenanceStore, { hashBytes, hashContent, publicProvenance } from '../ProvenanceStore.js';

export const REPORT_TYP = 'ihub-detection-report+jws';
const AI_SOURCE_TYPES = new Set([
  DIGITAL_SOURCE_TYPES.trainedAlgorithmicMedia,
  DIGITAL_SOURCE_TYPES.compositeWithTrainedAlgorithmicMedia,
  'http://c2pa.org/digitalsourcetype/trainedAlgorithmicData',
  'http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia'
]);
const MIN_TEXT_WATERMARK_TOKENS = 50;

const LABELS = {
  c2pa: 'C2PA manifest (signed metadata)',
  trustmark: 'Invisible image watermark (TrustMark)',
  xmp: 'IPTC/XMP metadata',
  'ihub-manifest': 'Signed iHub provenance manifest',
  'text-signpost': 'Text signpost (C2PA text wrapper)',
  'text-watermark': 'Text watermark',
  'provenance-record': 'Provenance record of this installation',
  metadata: 'Document metadata'
};

function technique(name, fields) {
  return {
    technique: name,
    label: LABELS[name] || name,
    found: false,
    valid: null,
    trusted: null,
    detail: '',
    ...fields
  };
}

/**
 * What kind of content this is.
 * @param {Buffer} buffer
 * @param {string} [declared] - declared MIME type
 * @returns {Promise<{kind: string, mimeType: string}>}
 */
export async function sniffContent(buffer, declared = '') {
  const image = sniffImageType(buffer);
  if (image) return { kind: 'image', mimeType: image };
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-')
    return { kind: 'pdf', mimeType: 'application/pdf' };
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      if (zip.file('word/document.xml')) {
        return {
          kind: 'docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        };
      }
      if (zip.file('ppt/presentation.xml')) {
        return {
          kind: 'pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        };
      }
      if (zip.file('xl/workbook.xml')) {
        return {
          kind: 'xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        };
      }
    } catch {
      /* not a zip we know */
    }
    return { kind: 'other', mimeType: declared || 'application/zip' };
  }
  const text = buffer.toString('utf8');
  if (text.includes('�') && !declared.startsWith('text/')) {
    return { kind: 'other', mimeType: declared || 'application/octet-stream' };
  }
  const head = text.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html'))
    return { kind: 'html', mimeType: 'text/html' };
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      JSON.parse(text);
      return { kind: 'json', mimeType: 'application/json' };
    } catch {
      const first = text.split('\n')[0];
      try {
        JSON.parse(first);
        return { kind: 'json', mimeType: 'application/x-ndjson' };
      } catch {
        /* plain text */
      }
    }
  }
  return {
    kind: 'text',
    mimeType: declared && declared.startsWith('text/') ? declared : 'text/plain'
  };
}

function c2paTechnique(read) {
  if (!read || !read.available) {
    return technique('c2pa', {
      skipped: 'unavailable',
      detail: 'The C2PA library is not available here'
    });
  }
  if (!read.present)
    return technique('c2pa', { detail: read.error ? `Unreadable: ${read.error}` : 'No manifest' });
  const active = read.activeManifest || {};
  const actions = (active.assertions || [])
    .filter(a => String(a.label).startsWith('c2pa.actions'))
    .flatMap(a => a.data?.actions || []);
  const sourceTypes = actions.map(a => a.digitalSourceType).filter(Boolean);
  const aiGenerated = sourceTypes.some(t => AI_SOURCE_TYPES.has(t));
  const provenanceAssertion = (active.assertions || []).find(
    a => a.label === 'com.intrafind.ihub.provenance'
  );
  const state = read.validationState;
  return technique('c2pa', {
    found: true,
    valid: state === 'Valid' || state === 'Trusted',
    trusted: state === 'Trusted',
    aiGenerated,
    detail: [
      active.claim_generator_info?.map(g => g.name).join(', ') ||
        active.claim_generator ||
        'unknown generator',
      aiGenerated ? 'declares AI-generated content' : 'no AI source type declared',
      `validation: ${state}`
    ].join(' · '),
    data: {
      validationState: state,
      issues: (read.issues || []).map(i => i.code),
      actions: actions.map(a => a.action),
      digitalSourceTypes: sourceTypes,
      signer: active.signature_info?.issuer || active.signature_info?.common_name || null,
      signedAt: active.signature_info?.time || null,
      contentId: provenanceAssertion?.data?.contentId || null,
      signpost: provenanceAssertion?.data?.signpost || null
    }
  });
}

async function recordTechnique(contentHash, { byId } = {}) {
  const record = byId
    ? await provenanceStore.get(byId)
    : await provenanceStore.findByHash(contentHash);
  if (!record)
    return {
      entry: technique('provenance-record', { detail: 'Not known to this installation' }),
      record: null
    };
  return {
    entry: technique('provenance-record', {
      found: true,
      valid: true,
      trusted: true,
      detail: `Generated here on ${record.generatedAt}${record.model?.id ? ` by ${record.model.id}` : ''}`,
      data: { contentId: record.contentId, kind: record.kind }
    }),
    record
  };
}

function manifestTechnique(result) {
  if (!result.found) return technique('ihub-manifest', { detail: 'No iHub manifest' });
  if (!result.payload && result.errors?.length) {
    // Found but not checkable (e.g. the archive exceeds the inflation limits).
    return technique('ihub-manifest', {
      found: true,
      valid: false,
      trusted: false,
      detail: result.errors.join('; ')
    });
  }
  return technique('ihub-manifest', {
    found: true,
    valid: result.valid && result.intact,
    trusted: result.valid && result.intact && result.trusted,
    aiGenerated: result.payload?.aiGenerated === true,
    detail: [
      result.payload?.generator?.name || 'iHub Apps',
      result.intact ? 'file unchanged since signing' : 'file changed after signing',
      result.trusted ? 'trusted signer' : 'signer not trusted here',
      result.payload?.verification ? `content ${result.payload.verification}` : null
    ]
      .filter(Boolean)
      .join(' · '),
    data: {
      manifestId: result.payload?.manifestId,
      createdAt: result.payload?.createdAt,
      method: result.method,
      verification: result.payload?.verification,
      signpost: result.payload?.signpost,
      signer: result.signer?.subject,
      errors: result.errors
    }
  });
}

async function textTechniques(text, { canUseTextDetection, trustAnchors }) {
  const out = [];
  let record = null;
  const signpost = await verifyTextSignpost(text, { trustAnchors });
  out.push(
    signpost.found
      ? technique('text-signpost', {
          found: true,
          valid: signpost.valid && signpost.intact,
          trusted: signpost.valid && signpost.intact && signpost.trusted,
          aiGenerated: signpost.payload?.ai === true,
          detail: signpost.intact ? 'Signpost intact' : 'Text changed after it was signed',
          data: {
            signpost: signpost.payload?.signpost,
            contentId: signpost.payload?.cid,
            signer: signpost.signer?.subject,
            errors: signpost.errors
          }
        })
      : technique('text-signpost', { detail: 'No signpost' })
  );
  const clean = signpost.cleanText ?? text;
  const lookup = await recordTechnique(hashContent(clean));
  out.push(lookup.entry);
  record = lookup.record;
  const tokens = estimateTokens(clean);
  if (!canUseTextDetection) {
    out.push(
      technique('text-watermark', {
        skipped: 'experts-only',
        detail: 'Text watermark detection is limited to approved experts'
      })
    );
  } else if (tokens < MIN_TEXT_WATERMARK_TOKENS) {
    out.push(
      technique('text-watermark', {
        skipped: 'too-short',
        detail: `Too short for reliable detection (${tokens} tokens)`
      })
    );
  } else {
    const wm = await detectTextWatermark(clean);
    if (!wm.checked) {
      out.push(
        technique('text-watermark', {
          skipped: 'no-detector',
          detail: wm.errors.length
            ? `Detector unreachable: ${wm.errors.join('; ')}`
            : 'No watermark detector configured'
        })
      );
    } else {
      const best = wm.results.find(r => r.detected) || wm.results[0];
      out.push(
        technique('text-watermark', {
          found: wm.detected,
          valid: wm.detected ? true : null,
          trusted: wm.detected ? true : null,
          aiGenerated: wm.detected,
          detail: wm.detected
            ? `Watermark of key group ${best.keyGroup} v${best.keyVersion} (p = ${best.pValue?.toExponential(2) ?? 'n/a'})`
            : `No watermark found (${wm.results.length} key version(s) tested)`,
          data: { results: wm.results }
        })
      );
    }
  }
  return { techniques: out, record };
}

async function extractDocumentText(buffer, kind) {
  try {
    if (kind === 'pdf') {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false })
        .promise;
      const parts = [];
      for (let i = 1; i <= Math.min(doc.numPages, 50); i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        parts.push(content.items.map(item => item.str).join(' '));
      }
      return parts.join('\n');
    }
    if (kind === 'docx') {
      const zip = await JSZip.loadAsync(buffer);
      zipEntries(zip);
      const xml = await readZipEntry(zip.file('word/document.xml'), inflateBudget(), 'utf8');
      return docxText(xml);
    }
  } catch {
    return '';
  }
  return '';
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode the entities of an XML text node in one pass. */
function decodeXmlText(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== '#') return XML_ENTITIES[name] ?? entity;
    const code =
      name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
  });
}

/**
 * The text of a DOCX body: the `<w:t>` runs of each paragraph, one paragraph
 * per line. Reads the text nodes instead of stripping markup.
 * @param {string} xml - word/document.xml
 * @returns {string}
 */
export function docxText(xml) {
  return xml
    .split('</w:p>')
    .map(paragraph =>
      Array.from(paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g), m =>
        decodeXmlText(m[1])
      ).join('')
    )
    .join('\n');
}

function verdictOf(techniques) {
  const positive = techniques.filter(t => t.found && t.valid !== false && t.aiGenerated !== false);
  if (positive.length) return 'ai-generated';
  // A mark that is there but does not validate: changed content or a forgery.
  if (techniques.some(t => t.found && t.valid === false)) return 'inconclusive';
  // Nothing could be checked at all (e.g. no library for this format).
  if (techniques.length > 0 && techniques.every(t => t.skipped)) return 'inconclusive';
  return 'not-detected';
}

function summaryOf(verdict, techniques) {
  const found = techniques.filter(t => t.found).map(t => t.label);
  const skipped = techniques.filter(t => t.skipped).map(t => `${t.label} (${t.detail})`);
  const notChecked = skipped.length ? ` Not checked: ${skipped.join('; ')}.` : '';
  if (verdict === 'ai-generated') return `AI-generated content: found by ${found.join(', ')}.`;
  if (verdict === 'inconclusive') {
    return found.length
      ? `Marks found (${found.join(', ')}), but they do not validate — the content may have been changed.`
      : `No technique could check this content.${notChecked}`;
  }
  return `No AI marking of this installation found. Absence of a mark does not prove human authorship.${notChecked}`;
}

/**
 * Verify content.
 *
 * @param {Object} input
 * @param {Buffer} [input.buffer] - a file
 * @param {string} [input.text] - pasted text
 * @param {string} [input.mimeType] - declared type of the file
 * @param {Object} [opts]
 * @param {boolean} [opts.canUseTextDetection=false] - approved expert / admin
 * @param {string[]} [opts.trustAnchors] - extra PEM anchors (CLI)
 * @param {boolean} [opts.sign=true] - sign a report
 * @returns {Promise<{result: Object, report: string|null, reportPayload: Object}>}
 */
export async function verifyContent(
  input,
  { canUseTextDetection = false, trustAnchors = [], sign = true } = {}
) {
  const buffer = input.buffer ?? Buffer.from(String(input.text ?? ''), 'utf8');
  const { kind, mimeType } = input.buffer
    ? await sniffContent(buffer, input.mimeType || '')
    : { kind: 'text', mimeType: 'text/plain' };
  const anchors = [...(await signingService.getTrustAnchors()), ...trustAnchors];
  const techniques = [];
  let record = null;
  const fileHash = hashBytes(buffer);

  if (kind === 'image') {
    techniques.push(c2paTechnique(await readAsset(buffer, mimeType, { trustAnchors: anchors })));
    const wm = await decodeImageWatermark(buffer);
    if (wm.found) {
      const byId = await recordTechnique(null, { byId: wm.contentId });
      record = byId.record;
      techniques.push(
        technique('trustmark', {
          found: true,
          valid: true,
          trusted: Boolean(byId.record),
          aiGenerated: true,
          detail: byId.record
            ? `Watermark id ${wm.contentId}, generated here on ${byId.record.generatedAt}`
            : `Watermark id ${wm.contentId} (not issued by this installation)`,
          data: { contentId: wm.contentId }
        })
      );
    } else {
      techniques.push(
        technique('trustmark', {
          detail: wm.error ? `Watermark check unavailable: ${wm.error}` : 'No watermark',
          ...(wm.error ? { skipped: 'unavailable' } : {})
        })
      );
    }
    const xmp = readXmp(buffer);
    const declared = xmp && [...AI_SOURCE_TYPES].some(t => xmp.includes(t));
    techniques.push(
      technique('xmp', {
        found: Boolean(declared),
        valid: declared ? true : null,
        aiGenerated: declared ? true : undefined,
        detail: declared
          ? 'DigitalSourceType declares AI-generated content'
          : xmp
            ? 'XMP without AI declaration'
            : 'No XMP'
      })
    );
  } else if (kind === 'text') {
    const text = buffer.toString('utf8');
    const res = await textTechniques(text, { canUseTextDetection, trustAnchors: anchors });
    techniques.push(...res.techniques);
    record = res.record;
  } else if (['pdf', 'docx', 'pptx', 'xlsx', 'html', 'json'].includes(kind)) {
    if (C2PA_READABLE_TYPES.includes(mimeType)) {
      const read = await readAsset(buffer, mimeType, { trustAnchors: anchors });
      if (read.present) techniques.push(c2paTechnique(read));
    }
    techniques.push(
      manifestTechnique(await verifyExportManifest(buffer, { kind, trustAnchors: anchors }))
    );
    if (kind === 'pdf') {
      const xmpText = buffer.toString('latin1');
      const declared = [...AI_SOURCE_TYPES].some(t => xmpText.includes(t));
      techniques.push(
        technique('xmp', {
          found: declared,
          valid: declared ? true : null,
          aiGenerated: declared ? true : undefined,
          detail: declared
            ? 'XMP DigitalSourceType declares AI-generated content'
            : 'No AI declaration in XMP'
        })
      );
    }
    if (canUseTextDetection && (kind === 'pdf' || kind === 'docx')) {
      const text = await extractDocumentText(buffer, kind);
      if (estimateTokens(text) >= MIN_TEXT_WATERMARK_TOKENS) {
        const wm = await detectTextWatermark(text);
        if (wm.checked) {
          techniques.push(
            technique('text-watermark', {
              found: wm.detected,
              valid: wm.detected ? true : null,
              aiGenerated: wm.detected,
              detail: wm.detected
                ? 'Text watermark found in the document text'
                : 'No text watermark in the document text'
            })
          );
        }
      }
    }
  }

  if (!record) {
    const byFile = await recordTechnique(fileHash);
    if (byFile.record) {
      record = byFile.record;
      const existing = techniques.findIndex(t => t.technique === 'provenance-record');
      if (existing >= 0) techniques[existing] = byFile.entry;
      else techniques.push(byFile.entry);
    } else if (!techniques.some(t => t.technique === 'provenance-record')) {
      techniques.push(byFile.entry);
    }
  }

  const verdict = verdictOf(techniques);
  const installationUrl = getInstallationUrl();
  const detector = {
    id: getInstallationId(),
    installationUrl: installationUrl || null,
    version: getAppVersion()
  };
  const checkedAt = new Date().toISOString();
  const result = {
    verdict,
    aiGenerated: verdict === 'ai-generated' ? true : verdict === 'not-detected' ? false : null,
    techniques,
    content: { sha256: fileHash, mimeType, size: buffer.length, kind },
    provenance: record ? publicProvenance(record) : null,
    detector,
    checkedAt,
    summary: summaryOf(verdict, techniques)
  };
  const reportPayload = {
    typ: 'ihub-detection-report',
    v: 1,
    detector,
    checkedAt,
    content: { sha256: fileHash, mimeType, size: buffer.length, kind },
    verdict,
    techniques: techniques.map(t => ({
      technique: t.technique,
      found: t.found,
      valid: t.valid,
      trusted: t.trusted,
      ...(t.skipped ? { skipped: t.skipped } : {})
    })),
    ...(record
      ? { provenance: { contentId: record.contentId, generatedAt: record.generatedAt } }
      : {})
  };
  const report = sign ? await signingService.signPayload(reportPayload, { typ: REPORT_TYP }) : null;
  return { result, report, reportPayload };
}

/**
 * Verify a signed detection report.
 * @param {string} token
 */
export async function verifyDetectionReport(token) {
  const verified = await signingService.verifyPayload(token);
  const typOk =
    verified.header?.typ === REPORT_TYP && verified.payload?.typ === 'ihub-detection-report';
  return {
    valid: verified.valid && typOk,
    trusted: verified.trusted && typOk,
    payload: verified.payload,
    signer: verified.signer,
    errors: typOk ? verified.errors : [...verified.errors, 'Not an iHub detection report']
  };
}
