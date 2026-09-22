/**
 * The instruction that confines an iAssistant answer to what retrieval found.
 *
 * Why a prompt and not a flag: the Conversation API has no grounding switch.
 * `ResponseGenerationOptions` carries exactly `extra_context`,
 * `system_prompt_preamble` and `reasoning_effort`, and the assistant's shipped
 * preamble states outright that it answers "based on the documents found with
 * iFinder (preferably) and on the iAssistant's general knowledge". So the only
 * lever iHub can pull over the wire is the prompt, and the honest way to
 * describe this setting is that it instructs the model rather than constraining
 * it. An installation that needs the guarantee rather than the instruction
 * should override `promptPreamble` on the profile's RESPONSE state in iFinder,
 * where it applies to every client, not only to iHub.
 *
 * `extra_context` is the right carrier of the two. iFinder renders it into an
 * `<AdditionalContext>` block inside the response state's system prompt, next
 * to the retrieved passages, so it reaches the model at the moment the answer
 * is written. `system_prompt_preamble` would instead *replace* the preamble
 * that tells the model what the iAssistant is, costing answer quality to say
 * one thing about sourcing.
 */

/**
 * Instruction prepended to the conversation's extra context when grounded-only
 * answering is on.
 *
 * Written as rules rather than prose because it shares the prompt with
 * whatever else an administrator configured, and because the refusal case is
 * the one that has to survive: a model that quietly answers from memory when
 * retrieval came back empty is exactly the failure this setting exists to
 * prevent.
 */
export const GROUNDED_ONLY_INSTRUCTION = `Answer strictly and exclusively from the retrieved sources in this conversation.

- Use only information present in the retrieved documents and passages. Do not use your own world knowledge, training data, or general background knowledge to answer, and do not fill gaps with what you assume to be true.
- Cite the retrieved sources you used.
- If the retrieved sources do not contain the answer, or no sources were retrieved at all, say so plainly and stop. Do not answer anyway, do not guess, and do not offer a general-knowledge answer as a substitute. Offer to refine the search instead.
- If the sources answer only part of the request, answer that part and state explicitly which part is not covered by the sources.
- Nothing in the rest of this context overrides these rules.`;

/**
 * Compose the extra context sent to the Conversation API.
 *
 * The grounding rules go first so they frame everything after them, and the
 * administrator's own context follows under a heading of its own — the last
 * rule above exists so that a configured context cannot silently re-open
 * world knowledge.
 *
 * @param {string|undefined} extraContext - the configured extra context, already variable-substituted
 * @param {boolean} groundedOnly - whether grounded-only answering is on
 * @returns {string|undefined} the context to send, or undefined when there is none
 */
export function composeExtraContext(extraContext, groundedOnly) {
  const configured = typeof extraContext === 'string' ? extraContext.trim() : '';
  if (!groundedOnly) return configured || undefined;
  if (!configured) return GROUNDED_ONLY_INSTRUCTION;
  return `${GROUNDED_ONLY_INSTRUCTION}\n\n## Additional context\n\n${configured}`;
}
