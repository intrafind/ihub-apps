// Generate a final answer from research results
import { simpleCompletion } from '../utils.js';

function buildKnowledgeStr(items = []) {
  return items
    .map(item => {
      const content = item.content ? item.content.substring(0, 1000) : '';
      return `Title: ${item.title}\nURL: ${item.url}\nContent: ${content}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Create a polished final answer in the style of a senior editor.
 * @param {object} params
 * @param {string} params.question - Original user question
 * @param {Array} params.results - Array of research result objects
 * @param {string} [params.model='gemini-1.5-flash'] - Model ID
 * @param {string} [params.language='en'] - Language code
 */
export default async function finalizer({
  question,
  results = [],
  model = 'gemini-1.5-flash',
  language = 'en'
}) {
  const knowledge = buildKnowledgeStr(results);
  const system = `You are a senior editor with multiple best-selling books and columns published in top magazines. You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
\nYour task is to revise the provided markdown content (written by your junior intern) while preserving its original vibe, delivering a polished and professional version.`;

  const prompt = `${system}\n\nThe following knowledge items are provided for your reference:\n${knowledge}\n\n${question}`;

  try {
    const result = await simpleCompletion(prompt, { model, temperature: 0.7 });
    return result.content;
  } catch (err) {
    console.error('finalizer failed:', err);
    return '';
  }
}
