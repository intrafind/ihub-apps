import { simpleCompletion } from '../utils.js';
import fs from 'fs';

function getPrompt(answers) {
  return {
    system: `\
You are an article aggregator that creates a coherent, high-quality article by smartly merging multiple source articles. Your goal is to preserve the best original content while eliminating obvious redundancy and improving logical flow.

<core-instructions>
1. Content Preservation
ALWAYS preserve original sentences verbatim - do not delete
Select the highest quality version when multiple articles cover the same point
Maintain the original author's voice and technical accuracy
Keep direct quotes, statistics, and factual claims exactly as written
2. Smart Merging Process
Identify content clusters: Group sentences/paragraphs that discuss the same topic
Select best version: From each cluster, choose the most comprehensive, clear, or well-written version
Eliminate pure duplicates: Remove identical or near-identical sentences
Preserve complementary details: Keep different angles or additional details that add value
3. Logical Reordering
Arrange content in logical sequence (introduction → main points → conclusion)
Group related concepts together
Ensure smooth transitions between topics
Maintain chronological order when relevant (for news/events)
4. Quality Criteria for Selection
When choosing between similar content, prioritize:
Clarity: More understandable explanations
Completeness: More comprehensive coverage
Accuracy: Better sourced or more precise information
Relevance: More directly related to the main topic
</core-instructions>

<output-format>
Structure the final article with:
Clear section headings (when appropriate)
Logical paragraph breaks
Smooth flow between topics
No attribution to individual sources (present as unified piece)
</output-format>

Do not add your own commentary or analysis
Do not change technical terms, names, or specific details`,
    user: `Here are the answers to merge:\n${answers.map((a,i)=>`<answer-${i+1}>\n${a}\n</answer-${i+1}>`).join('\n\n')}\n\nYour output should read as a coherent, high-quality article that appears to be written by a single author, while actually being a careful curation of the best sentences from all input sources.`
  };
}

export default async function answerReducer({ answers, model = 'gemini-1.5-flash', temperature = 0.3 }) {
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error('answers must be a non-empty array');
  }

  const prompt = getPrompt(answers);

  try {
    const combined = `${prompt.system}\n\n${prompt.user}`;
    const result = await simpleCompletion(combined, { model, temperature });
    const text = result.content;

    const totalLength = answers.reduce((acc, cur) => acc + cur.length, 0);
    if (text.length / totalLength < 0.6) {
      return answers.join('\n\n');
    }
    return text;
  } catch (err) {
    console.error('Reducer error:', err);
    return answers.join('\n\n');
  }
}

// CLI usage for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node answerReducer.js <file1> <file2> ...');
    process.exit(1);
  }
  Promise.all(files.map(f => fs.promises.readFile(f, 'utf8')))
    .then(async contents => {
      const result = await answerReducer({ answers: contents });
      console.log(result);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}
