import {
  buildReportFileContent,
  describeVerdict,
  describeVerifyError,
  extractSignedReport,
  formatBytes,
  getFindingTechniques,
  getTechniqueKey,
  getTechniqueStatus,
  getTechniqueTrust,
  getVerifyAvailability,
  validateUpload
} from '../../../client/src/features/verify/utils/verifyResult';

/**
 * `/verify` page rules (EU AI Act Art. 50(2), issue #2573). The page has to
 * say plainly which technique found a mark, must not present "no mark" as
 * "made by a person", and must hand the signed report over unchanged.
 */

describe('getVerifyAvailability', () => {
  it('follows GET /api/provenance/info', () => {
    expect(getVerifyAvailability(null)).toBe('loading');
    expect(getVerifyAvailability({ enabled: false })).toBe('disabled');
    expect(getVerifyAvailability({ enabled: true, canVerify: true })).toBe('ready');
    expect(
      getVerifyAvailability({ enabled: true, canVerify: false, reason: 'authentication-required' })
    ).toBe('signin');
    expect(getVerifyAvailability({ enabled: true, canVerify: false, reason: 'forbidden' })).toBe(
      'forbidden'
    );
    expect(getVerifyAvailability({ enabled: true, canVerify: false, reason: 'disabled' })).toBe(
      'disabled'
    );
  });
});

describe('describeVerdict', () => {
  it('has a distinct tone, icon and key per verdict', () => {
    expect(describeVerdict('ai-generated')).toEqual({
      tone: 'ai',
      icon: 'sparkles',
      key: 'aiGenerated'
    });
    expect(describeVerdict('not-detected').key).toBe('notDetected');
    expect(describeVerdict('inconclusive').key).toBe('inconclusive');
    expect(describeVerdict('something-new').key).toBe('inconclusive');
  });
});

describe('technique status and trust', () => {
  const techniques = [
    { technique: 'c2pa', found: true, valid: true, trusted: true },
    { technique: 'trustmark', found: false, valid: null, trusted: null },
    { technique: 'text-watermark', found: false, valid: null, skipped: 'expert access required' },
    { technique: 'ihub-manifest', found: true, valid: false, trusted: false }
  ];

  it('tells found, none, skipped and invalid apart', () => {
    expect(techniques.map(getTechniqueStatus)).toEqual(['found', 'none', 'skipped', 'invalid']);
  });

  it('reports trust only for a technique that found something', () => {
    expect(techniques.map(getTechniqueTrust)).toEqual([
      'trusted',
      'notApplicable',
      'notApplicable',
      'untrusted'
    ]);
  });

  it('names only the techniques with a valid finding', () => {
    expect(getFindingTechniques(techniques).map(t => t.technique)).toEqual(['c2pa']);
  });

  it('maps technique ids to i18n keys', () => {
    expect(getTechniqueKey('ihub-manifest')).toBe('ihubManifest');
    expect(getTechniqueKey('provenance-record')).toBe('provenanceRecord');
    expect(getTechniqueKey('future-technique')).toBeNull();
  });
});

describe('uploads', () => {
  it('rejects empty and oversized files', () => {
    expect(validateUpload(null, 10)).toBe('empty');
    expect(validateUpload({ size: 0 }, 10)).toBe('empty');
    expect(validateUpload({ size: 11 * 1024 * 1024 }, 10)).toBe('tooLarge');
    expect(validateUpload({ size: 1024 }, 10)).toBeNull();
    expect(validateUpload({ size: 1024 }, undefined)).toBeNull();
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes('x')).toBe('');
  });
});

describe('signed reports', () => {
  const token = 'eyJhbGciOiJFUzI1NiJ9.eyJ0eXAiOiJpaHViIn0.c2ln';

  it('finds the token in a downloaded report, a JSON string or on its own', () => {
    const file = buildReportFileContent({ report: token, reportPayload: { v: 1 }, result: {} });
    expect(JSON.parse(file)).toEqual({ report: token, reportPayload: { v: 1 }, result: {} });
    expect(extractSignedReport(file)).toBe(token);
    expect(extractSignedReport(`  ${token}\n`)).toBe(token);
    expect(extractSignedReport(JSON.stringify(token))).toBe(token);
  });

  it('refuses input without a token', () => {
    expect(extractSignedReport('')).toBeNull();
    expect(extractSignedReport('{"report":null}')).toBeNull();
    expect(extractSignedReport('not a report')).toBeNull();
  });

  it('keeps an unsigned report downloadable', () => {
    expect(JSON.parse(buildReportFileContent({ result: { verdict: 'x' } }))).toEqual({
      report: null,
      reportPayload: null,
      result: { verdict: 'x' }
    });
  });
});

describe('describeVerifyError', () => {
  it('maps statuses to translated messages', () => {
    expect(describeVerifyError({ status: 429 }).key).toBe('verify.errors.rateLimited');
    expect(describeVerifyError({ status: 401 }).key).toBe('verify.errors.signin');
    expect(describeVerifyError({ status: 403 }).key).toBe('verify.errors.forbidden');
    expect(describeVerifyError({ status: 400, message: 'The file is too large' })).toMatchObject({
      key: 'verify.errors.failed',
      params: { message: 'The file is too large' }
    });
    expect(describeVerifyError(null).key).toBe('verify.errors.generic');
  });
});
