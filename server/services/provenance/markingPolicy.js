/**
 * Which marking duty applies to one output, and whether it was met
 * (concept §4, §5.1; CoP Sub-measure 1.1.2).
 *
 * Free-form text over the token threshold (200 by default) must carry an
 * imperceptible watermark. It is met when the model is watermarked by iHub's
 * vLLM integration (and sampling had freedom to embed it) or by the upstream
 * vendor. An unmarked model stays unmarked even when an admin acknowledged it:
 * the acknowledgement documents the gap, it does not close it.
 *
 * @module services/provenance/markingPolicy
 */
import {
  estimateTokens,
  normalizeContentMarking,
  watermarkEmbedsAtTemperature
} from '../../../shared/aiTransparency.js';
import { isRecordForThisInstallation } from './installation.js';

/**
 * The app's declared Art. 50(2) exemption, if it was declared on this
 * installation.
 * @param {Object} app
 * @returns {Object|null}
 */
export function validExemption(app) {
  const exemption = app?.aiTransparency?.exemption;
  return exemption && isRecordForThisInstallation(exemption) ? exemption : null;
}

/**
 * The app's disclosure opt-out, if it was made on this installation. A record
 * copied in from elsewhere is ignored, so the disclosure stays on.
 * @param {Object} app
 * @returns {Object|null}
 */
export function validDisclosureOptOut(app) {
  const optOut = app?.aiTransparency?.disclosureOptOut;
  return optOut && isRecordForThisInstallation(optOut) ? optOut : null;
}

/**
 * The model's unmarked-model acknowledgement, if made on this installation.
 * @param {Object} model
 * @returns {Object|null}
 */
export function validAcknowledgement(model) {
  const ack = model?.contentMarking?.acknowledgement;
  return ack && isRecordForThisInstallation(ack) ? ack : null;
}

/**
 * Evaluate the text-marking duty for one generated text.
 *
 * @param {Object} params
 * @param {string} params.content
 * @param {Object|null} params.model - model config
 * @param {Object|null} [params.app] - app config
 * @param {number|null} [params.temperature]
 * @param {Object} params.cfg - resolved `platform.aiTransparency`
 * @returns {{tokens: number, required: boolean, status: 'marked'|'unmarked'|'exempt'|'not-required', technique: string|null, keyGroup: string|null, reason: string|null, conforming: boolean}}
 */
export function evaluateTextMarking({ content, model, app = null, temperature = null, cfg }) {
  const tokens = estimateTokens(content || '');
  const min = Number(cfg?.text?.watermarkMinTokens) || 200;
  const marking = normalizeContentMarking(model || {});
  const base = { tokens, technique: null, keyGroup: null, reason: null };

  const exemption = validExemption(app);
  if (exemption) {
    return { ...base, required: false, status: 'exempt', reason: exemption.type, conforming: true };
  }
  if (marking.text.kind === 'not-applicable') {
    return {
      ...base,
      required: false,
      status: 'exempt',
      reason: 'transcription',
      conforming: true
    };
  }
  const required = tokens > min;

  if (marking.text.kind === 'scheme') {
    const embeds = watermarkEmbedsAtTemperature(temperature);
    if (embeds) {
      return {
        ...base,
        required,
        status: required ? 'marked' : 'not-required',
        technique: marking.text.scheme,
        keyGroup: marking.text.keyGroup,
        conforming: true
      };
    }
    return {
      ...base,
      required,
      status: required ? 'unmarked' : 'not-required',
      technique: marking.text.scheme,
      keyGroup: marking.text.keyGroup,
      reason: 'temperature-zero',
      conforming: !required
    };
  }
  if (marking.text.kind === 'upstream') {
    return {
      ...base,
      required,
      status: required ? 'marked' : 'not-required',
      technique: `upstream:${marking.text.vendor}`,
      conforming: true
    };
  }
  return {
    ...base,
    required,
    status: required ? 'unmarked' : 'not-required',
    reason: 'model-unmarked',
    conforming: !required
  };
}
