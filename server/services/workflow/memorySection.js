/**
 * Reading a named section out of an agent profile's long-term memory file.
 *
 * Shared by the `memory` node and the transform node's legacy
 * `readAgentMemorySection` operation so both slice memory identically.
 *
 * @module services/workflow/memorySection
 */

const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/;

/**
 * Returns the body of a `## <heading>` section, up to the next `## ` heading.
 *
 * @param {string} body - Full markdown memory body
 * @param {string} section - Heading text to find, without the leading `## `
 * @returns {string} The section's text, or '' when the heading is absent
 */
export function sliceMemorySection(body, section) {
  if (!body || typeof section !== 'string') return '';
  const target = section.trim();
  const lines = body.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_HEADING_RE);
    if (m && m[1].trim() === target) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (SECTION_HEADING_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/**
 * Lists the `## ` headings a memory body defines, so an editor can offer the
 * real section names instead of asking the author to remember them.
 *
 * @param {string} body - Full markdown memory body
 * @returns {string[]} Heading texts in document order
 */
export function listMemorySections(body) {
  if (!body) return [];
  return body
    .split('\n')
    .map(line => line.match(SECTION_HEADING_RE))
    .filter(Boolean)
    .map(m => m[1].trim());
}

export default sliceMemorySection;
