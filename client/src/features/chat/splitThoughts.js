/**
 * Break streamed reasoning into readable steps.
 *
 * Providers stream reasoning token by token with no boundaries, and the run
 * reducer merges those tokens into one string. Reasoning models separate their
 * steps with blank lines, so a blank line starts a new thought. Named thoughts
 * (`{ name, content }`, e.g. workflow phases) are already discrete and pass
 * through unchanged.
 *
 * @param {Array<string|{name: string, content?: string}>} thoughts
 * @returns {Array<string|{name: string, content?: string}>}
 */
export function splitThoughts(thoughts) {
  if (!Array.isArray(thoughts)) return [];
  return thoughts.flatMap(thought => {
    if (typeof thought !== 'string') return [thought];
    return thought
      .split(/\n[ \t]*\n/)
      .map(part => part.trim())
      .filter(Boolean);
  });
}
