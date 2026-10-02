/**
 * Translated labels for values the detector and benchmark return as ids
 * (techniques, verdicts, requester types, access levels). Shared by the
 * Detection tab panels so the same id always reads the same way.
 *
 * Every function takes the i18next `t` so the keys stay literal and can be
 * extracted; unknown ids fall back to the server's label or the raw id.
 *
 * @module features/admin/components/euAiAct/detectionLabels
 */

/**
 * @param {import('i18next').TFunction} t
 * @param {string} technique - e.g. `c2pa`, `text-watermark`
 * @param {string} [serverLabel] - English label from the server, used for unknown ids
 * @returns {string}
 */
export function techniqueLabel(t, technique, serverLabel) {
  switch (technique) {
    case 'c2pa':
      return t('admin.euAiAct.detection.techniques.c2pa', 'C2PA manifest');
    case 'ihub-manifest':
      return t('admin.euAiAct.detection.techniques.ihubManifest', 'iHub manifest');
    case 'trustmark':
      return t('admin.euAiAct.detection.techniques.trustmark', 'TrustMark watermark');
    case 'xmp':
      return t('admin.euAiAct.detection.techniques.xmp', 'IPTC/XMP metadata');
    case 'text-signpost':
      return t('admin.euAiAct.detection.techniques.textSignpost', 'Text signpost');
    case 'text-watermark':
      return t('admin.euAiAct.detection.techniques.textWatermark', 'Text watermark');
    case 'provenance-record':
      return t('admin.euAiAct.detection.techniques.provenanceRecord', 'Provenance record');
    default:
      return serverLabel || technique || '—';
  }
}

/**
 * Short verdict text.
 * @param {import('i18next').TFunction} t
 * @param {'ai-generated'|'not-detected'|'inconclusive'|string} verdict
 * @returns {string}
 */
export function verdictLabel(t, verdict) {
  switch (verdict) {
    case 'ai-generated':
      return t('admin.euAiAct.detection.verdict.aiGenerated', 'AI-generated');
    case 'not-detected':
      return t('admin.euAiAct.detection.verdict.notDetected', 'No AI marking found');
    case 'inconclusive':
      return t('admin.euAiAct.detection.verdict.inconclusive', 'Inconclusive');
    default:
      return verdict || '—';
  }
}

/**
 * Marking status of a provenance record (`provenance.marking.status`).
 * @param {import('i18next').TFunction} t
 * @param {'marked'|'unmarked'|'exempt'|'not-required'|string} status
 * @returns {string}
 */
export function markingStatusLabel(t, status) {
  switch (status) {
    case 'marked':
      return t('admin.euAiAct.detection.marking.marked', 'Marked');
    case 'unmarked':
      return t('admin.euAiAct.detection.marking.unmarked', 'Not marked');
    case 'exempt':
      return t('admin.euAiAct.detection.marking.exempt', 'Exempt');
    case 'not-required':
      return t('admin.euAiAct.detection.marking.notRequired', 'Not required');
    default:
      return status || '—';
  }
}

/**
 * @param {import('i18next').TFunction} t
 * @param {'user'|'anonymous'|'cli'|string} type
 * @returns {string}
 */
export function requesterTypeLabel(t, type) {
  switch (type) {
    case 'user':
      return t('admin.euAiAct.detection.requester.user', 'User');
    case 'anonymous':
      return t('admin.euAiAct.detection.requester.anonymous', 'Anonymous');
    case 'cli':
      return t('admin.euAiAct.detection.requester.cli', 'Command line');
    default:
      return type || '—';
  }
}

/**
 * Label and explanation of a detector access level.
 * @param {import('i18next').TFunction} t
 * @param {'internal'|'authenticated'|'public'|string} access
 * @returns {{ label: string, description: string }}
 */
export function accessLevelText(t, access) {
  switch (access) {
    case 'internal':
      return {
        label: t('admin.euAiAct.detection.access.internal', 'Internal'),
        description: t(
          'admin.euAiAct.detection.access.internalDesc',
          'Only admins and approved experts can check content.'
        )
      };
    case 'authenticated':
      return {
        label: t('admin.euAiAct.detection.access.authenticated', 'Signed-in users'),
        description: t(
          'admin.euAiAct.detection.access.authenticatedDesc',
          'Every signed-in user of this installation can check content.'
        )
      };
    case 'public':
      return {
        label: t('admin.euAiAct.detection.access.public', 'Public'),
        description: t(
          'admin.euAiAct.detection.access.publicDesc',
          'Anyone can check content without signing in, rate-limited.'
        )
      };
    default:
      return { label: access || '—', description: '' };
  }
}
