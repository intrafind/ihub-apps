/**
 * Signed EU AI Act compliance report (CoP Measures 4.1, 4.4; concept §8.6;
 * issue #2577). Generated server-side from the current state, so it is
 * reproducible: configuration and marking techniques per modality and
 * model, the latest robustness test results, every opt-out, exemption,
 * acknowledgement and dismissal with its justification, the certificate
 * chain, the provider and editorial contacts, version and date. Signed like
 * every other export (iHub manifest in the PDF).
 *
 * @module services/provenance/report/ComplianceReport
 */
import crypto from 'node:crypto';
import { getAppVersion } from '../../../utils/versionHelper.js';
import { getLocalizedContent } from '../../../../shared/localize.js';
import { DIGITAL_SOURCE_TYPES } from '../../../../shared/aiTransparency.js';
import { evaluateCompliance } from '../ComplianceService.js';
import { getAiTransparencyConfig } from '../config.js';
import { renderExport } from '../export/renderers/index.js';
import { signExport } from '../export/ExportSigner.js';
import { latestBenchmark } from '../benchmark/MarkingBenchmark.js';

const cell = value =>
  String(value ?? '—')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

function table(headers, rows) {
  if (!rows.length) return '_None._\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)
  ].join('\n');
}

const name = v => getLocalizedContent(v, 'en') || '';

/**
 * The report as Markdown (also used by tests).
 * @param {Object} status - evaluateCompliance() result
 * @param {Object} cfg - resolved aiTransparency
 * @param {Object|null} benchmark - latest benchmark report
 */
export function complianceReportMarkdown(status, cfg, benchmark) {
  const s = status;
  const lines = [];
  lines.push('# EU AI Act Art. 50 compliance report');
  lines.push('');
  lines.push(
    `Generated ${s.generatedAt} by iHub Apps ${getAppVersion()} for installation \`${s.installation.installationId}\`` +
      (s.installation.installationUrl ? ` (${s.installation.installationUrl})` : '') +
      '.'
  );
  lines.push('');
  lines.push(`**Overall status:** ${s.conforming ? 'conforming' : 'non-conforming'}`);
  lines.push('');
  lines.push('This is an engineering record of the installation, not legal advice.');
  lines.push('');
  lines.push('## Provider and contacts');
  lines.push('');
  lines.push(
    table(
      ['Item', 'Value'],
      [
        ['Legal entity', cfg.provider.legalEntity || 'not recorded'],
        ['Role (Art. 3(3))', cfg.provider.role],
        ['Contact', cfg.provider.contact || 'not recorded'],
        ['Address', cfg.provider.address || '—'],
        [
          'Editorial responsibility (Art. 50(4))',
          cfg.editorialResponsibility.contact || 'not recorded'
        ],
        ['Editorial policy', cfg.editorialResponsibility.policyUrl || '—'],
        [
          'Terms of service prohibit removing markings (CoP 1.2(b))',
          cfg.termsOfService.markRemovalClause
            ? `yes${cfg.termsOfService.url ? ` (${cfg.termsOfService.url})` : ''}`
            : 'no'
        ]
      ]
    )
  );
  lines.push('');
  lines.push('## Conformance checklist');
  lines.push('');
  lines.push(
    table(
      ['Item', 'Status', 'Detail'],
      s.checklist.map(c => [c.id, c.status, c.detail])
    )
  );
  lines.push('');
  lines.push('## Marking techniques');
  lines.push('');
  lines.push(
    table(
      ['Modality', 'Technique', 'Setting'],
      [
        [
          'Interaction (50(1))',
          'Disclosure before the first interaction, persistent AI badge, guardrail',
          cfg.interactionDisclosure.enabled ? 'on' : 'off'
        ],
        [
          'Images',
          `C2PA manifest (${DIGITAL_SOURCE_TYPES.trainedAlgorithmicMedia})`,
          cfg.images.c2pa ? 'on' : 'off'
        ],
        ['Images', 'TrustMark invisible watermark (C2PA soft binding)', cfg.images.watermark],
        ['Images', 'IPTC/XMP DigitalSourceType', cfg.images.xmp ? 'on' : 'off'],
        [
          'Exports',
          'Signed iHub manifest + format metadata + visible label',
          cfg.exports.sign ? 'on' : 'off'
        ],
        ['Text exports', 'C2PA text wrapper signpost', cfg.text.signpost.exports ? 'on' : 'off'],
        ['Clipboard', 'C2PA text wrapper signpost', cfg.text.signpost.clipboard ? 'on' : 'off'],
        [
          'Free-form text',
          `Watermark over ${cfg.text.watermarkMinTokens} tokens (per model, below)`,
          cfg.text.strictMode ? 'strict mode' : 'flag, do not block'
        ],
        [
          'Records',
          'Provenance record per output (hash, model, time)',
          cfg.provenance.enabled ? `on, ${cfg.provenance.retentionDays} days` : 'off'
        ],
        [
          'Signing',
          'Time-stamping',
          s.signing.timestamping === 'tsa' ? `RFC 3161 TSA (${s.signing.tsaUrl})` : 'local clock'
        ]
      ]
    )
  );
  lines.push('');
  lines.push('## Models');
  lines.push('');
  lines.push(
    table(
      ['Model', 'Enabled', 'Text marking', 'Image marking', 'Conforming', 'Acknowledgement'],
      s.models.map(m => [
        `${name(m.name) || m.id} (${m.id})`,
        m.enabled ? 'yes' : 'no',
        m.text.status +
          (m.text.keyGroup ? ` [${m.text.keyGroup}]` : '') +
          (m.text.vendor ? ` [${m.text.vendor}]` : ''),
        m.image
          ? m.image.status + (m.image.upstream ? ` + upstream ${m.image.upstream}` : '')
          : 'n/a',
        m.conforming ? 'yes' : 'no',
        m.acknowledgement
          ? `${m.acknowledgement.acknowledgedByName || m.acknowledgement.acknowledgedBy}, ${m.acknowledgement.acknowledgedAt}: ${m.acknowledgement.justification}`
          : '—'
      ])
    )
  );
  lines.push('');
  lines.push(
    'Models whose text is not marked stay non-conforming for free-form text over the token threshold, acknowledged or not (CoP Sub-measure 1.1.2). At temperature 0 a distortion-free watermark embeds nothing; such apps are listed below.'
  );
  lines.push('');
  lines.push('## Apps: disclosure, exemptions, low-entropy settings');
  lines.push('');
  lines.push(
    table(
      ['App', 'Disclosure', 'Exemption', 'Sensitive', 'Temperature 0'],
      s.apps.map(a => [
        `${name(a.name) || a.id} (${a.id})`,
        a.disclosure,
        a.exemption ? a.exemption.type : '—',
        a.sensitive || '—',
        a.temperatureZero ? 'yes (no watermark embedded)' : 'no'
      ])
    )
  );
  lines.push('');
  lines.push('## Opt-outs, exemptions, acknowledgements and dismissals');
  lines.push('');
  lines.push('### Disclosure opt-outs (Art. 50(1))');
  lines.push(
    table(
      ['App', 'By', 'When', 'Reason', 'Installation'],
      s.records.optOuts.map(r => [
        r.appId,
        r.disabledByName || r.disabledBy,
        r.disabledAt,
        r.reason,
        r.installationUrl || r.installationId
      ])
    )
  );
  lines.push('');
  lines.push('### Exemptions (Art. 50(2))');
  lines.push(
    table(
      ['App', 'Type', 'By', 'When', 'Justification'],
      s.records.exemptions.map(r => [
        r.appId,
        r.type,
        r.declaredByName || r.declaredBy,
        r.declaredAt,
        r.justification
      ])
    )
  );
  lines.push('');
  lines.push('### Dismissed warnings');
  lines.push(
    table(
      ['Warning', 'By', 'When', 'Reason'],
      s.records.dismissals.map(r => [
        r.message || r.warningId,
        r.dismissedByName || r.dismissedBy,
        r.dismissedAt,
        r.reason
      ])
    )
  );
  lines.push('');
  lines.push(
    'Dismissing a warning hides it from the start page; it never changes the conformance status above.'
  );
  lines.push('');
  lines.push('## Signing certificates');
  lines.push('');
  lines.push(
    table(
      ['Status', 'Source', 'Subject', 'Issuer', 'Valid from', 'Valid until', 'SHA-256 fingerprint'],
      s.signing.certificates
        .filter(c => c.status !== 'pending')
        .map(c => [c.status, c.source, c.subject, c.issuer, c.notBefore, c.notAfter, c.fingerprint])
    )
  );
  if (s.signing.active?.chain?.length) {
    lines.push('');
    lines.push('Active chain:');
    lines.push('');
    for (const c of s.signing.active.chain)
      lines.push(`- ${c.subject} (issued by ${c.issuer}, until ${c.notAfter})`);
  }
  lines.push('');
  lines.push('## Detection');
  lines.push('');
  lines.push(
    table(
      ['Item', 'Value'],
      [
        [
          'Detector',
          cfg.detection.enabled ? '/verify and POST /api/provenance/verify' : 'disabled'
        ],
        ['Access', cfg.detection.access],
        ['Approved experts (text detection)', String((cfg.detection.experts || []).length)],
        ['Retention of submitted content', 'none'],
        [
          'Detection log',
          cfg.detection.log.enabled
            ? `metadata only, ${cfg.detection.log.retentionDays} days`
            : 'off'
        ],
        [
          'Text-watermark key groups',
          s.keyGroups.map(g => `${g.id} (v${g.activeVersion})`).join(', ') || 'none'
        ],
        ['Offline detector', '`ihub verify <file>` mode of the iHub binary']
      ]
    )
  );
  lines.push('');
  lines.push('## Robustness and reliability tests');
  lines.push('');
  if (benchmark) {
    lines.push(
      `Run ${benchmark.id} on ${benchmark.finishedAt} (${benchmark.quick ? 'self-test' : 'full benchmark'}): ${benchmark.summary.passed} passed, ${benchmark.summary.failed} failed, ${benchmark.summary.skipped} skipped.`
    );
    lines.push('');
    lines.push(
      table(
        ['Technique', 'Transform', 'Samples', 'TPR', 'FPR', 'Status', 'Note'],
        benchmark.results.map(r => [
          r.technique,
          r.transform,
          r.samples,
          r.tpr === null || r.tpr === undefined ? '—' : r.tpr.toFixed(2),
          r.fpr === null || r.fpr === undefined ? '—' : r.fpr.toFixed(2),
          r.status,
          r.note || ''
        ])
      )
    );
  } else {
    lines.push('_No test run recorded yet. Run the self-test on the EU AI Act page._');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the signed PDF.
 * @param {{req?: import('express').Request}} [opts]
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
export async function buildComplianceReport({ req } = {}) {
  const status = await evaluateCompliance({ req });
  const cfg = getAiTransparencyConfig();
  const benchmark = await latestBenchmark();
  const markdown = complianceReportMarkdown(status, cfg, benchmark);
  const rendered = await renderExport('pdf', {
    title: 'EU AI Act compliance report',
    appName: 'iHub Apps',
    exportedAt: status.generatedAt,
    language: 'en',
    settings: null,
    messages: [{ index: 0, role: 'assistant', content: markdown, verification: 'human' }],
    source: 'artifact',
    label: {
      show: false,
      text: '',
      euIcon: false,
      humanReviewed: false,
      editorialContact: null,
      provider: null
    },
    template: 'professional',
    single: true
  });
  const manifestId = `exp_${crypto.randomBytes(12).toString('base64url')}`;
  const signed = await signExport({
    format: 'pdf',
    buffer: rendered.buffer,
    payload: {
      v: 1,
      typ: 'ihub-compliance-report',
      manifestId,
      format: 'pdf',
      title: 'EU AI Act compliance report',
      createdAt: status.generatedAt,
      generator: { name: 'iHub Apps', version: getAppVersion() },
      installationId: status.installation.installationId,
      aiGenerated: false,
      digitalSourceType: DIGITAL_SOURCE_TYPES.softwareImage,
      conforming: status.conforming,
      checklist: status.checklist.map(c => ({ id: c.id, status: c.status }))
    },
    meta: {
      generator: `iHub Apps ${getAppVersion()}`,
      provider: cfg.provider.legalEntity,
      labelText: 'Compliance report'
    }
  }).catch(() => ({ buffer: rendered.buffer }));
  return {
    buffer: signed.buffer,
    filename: `eu-ai-act-compliance-report-${status.generatedAt.slice(0, 10)}.pdf`
  };
}
