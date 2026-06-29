/**
 * Preset strictness → concrete verifier knobs. Pure; see the design doc
 * docs/superpowers/specs/2026-06-25-configurable-agent-review-design.md.
 */
export const REVIEW_PRESETS = {
  lenient: {
    acceptPartial: true,
    acceptPartialAfterStall: true,
    requirePass: false,
    maxRetries: 2,
    stallLimit: 1
  },
  balanced: {
    acceptPartial: false,
    acceptPartialAfterStall: true,
    requirePass: false,
    maxRetries: 4,
    stallLimit: 2
  },
  strict: {
    acceptPartial: false,
    acceptPartialAfterStall: false,
    requirePass: true,
    maxRetries: 6,
    stallLimit: 2
  }
};

/**
 * Resolve a profile's `review` block into verifier knobs.
 * @param {Object} [review] - profile.review ({ strictness, maxRounds, stallLimit, criteria })
 * @returns {{strictness:string, acceptPartial:boolean, acceptPartialAfterStall:boolean, requirePass:boolean, maxRetries:number, stallLimit:number, criteria?:string}}
 */
export function resolveReviewSettings(review) {
  const strictness = REVIEW_PRESETS[review?.strictness] ? review.strictness : 'balanced';
  const preset = REVIEW_PRESETS[strictness];
  const out = { strictness, ...preset };
  if (typeof review?.maxRounds === 'number') out.maxRetries = review.maxRounds;
  if (typeof review?.stallLimit === 'number') out.stallLimit = review.stallLimit;
  if (typeof review?.criteria === 'string' && review.criteria.trim())
    out.criteria = review.criteria.trim();
  return out;
}
