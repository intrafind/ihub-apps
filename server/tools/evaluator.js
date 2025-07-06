import { simpleCompletion } from '../utils.js';

function getDefinitivePrompt(question, answer) {
  return `You are an evaluator of answer definitiveness. Return a JSON object {\"think\":string,\"pass\":boolean}.
Use these rules:\n- Definitive answers provide clear statements without uncertainty.\n- Non-definitive answers include phrases like 'I don't know' or redirects without addressing the question.\nQuestion: ${question}\nAnswer: ${answer}`;
}

function getFreshnessPrompt(question, answer, currentTime) {
  return `You are an evaluator that checks if an answer might be outdated. Compare any dates in the answer to the current time ${currentTime}. If information is older than allowed per domain guidelines, fail. Return JSON {\"think\":string,\"pass\":boolean}.\nQuestion: ${question}\nAnswer: ${answer}`;
}

function getCompletenessPrompt(question, answer) {
  return `You are an evaluator that checks if an answer covers all explicitly mentioned aspects of the question. Identify which aspects are mentioned and whether they are addressed. Return JSON {\"think\":string,\"pass\":boolean}.\nQuestion: ${question}\nAnswer: ${answer}`;
}

export default async function evaluator({ question, answer, model = 'gemini-1.5-flash' }) {
  if (!question || !answer) {
    throw new Error('question and answer parameters are required');
  }

  const types = ['definitive', 'freshness', 'completeness'];
  const prompts = {
    definitive: getDefinitivePrompt(question, answer),
    freshness: getFreshnessPrompt(question, answer, new Date().toISOString()),
    completeness: getCompletenessPrompt(question, answer)
  };

  const results = [];
  for (const type of types) {
    try {
      const completion = await simpleCompletion(prompts[type], { model, temperature: 0 });
      const parsed = JSON.parse(completion.trim());
      results.push({ type, ...parsed });
      if (!parsed.pass) break;
    } catch (err) {
      results.push({ type, pass: false, think: `Error during ${type} evaluation: ${err.message}` });
      break;
    }
  }

  return { evaluation: results };
}
