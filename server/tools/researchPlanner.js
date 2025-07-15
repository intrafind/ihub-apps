import { simpleCompletion } from '../utils.js';

/**
 * Generate a research plan by decomposing a question into focused tasks.
 * Returns JSON with a list of subproblems and a think note.
 */
export default async function researchPlanner({
  question,
  teamSize = 3,
  soundBites = '',
  model = 'gemini-1.5-flash'
}) {
  if (!question) {
    throw new Error('question parameter is required');
  }

  const currentTime = new Date();
  const currentYear = currentTime.getFullYear();
  const currentMonth = currentTime.getMonth() + 1;

  const system = `\nYou are a Principal Research Lead managing a team of ${teamSize} junior researchers. Your role is to break down a complex research topic into focused, manageable subproblems and assign them to your team members.\n\nUser give you a research topic and some soundbites about the topic, and you follow this systematic approach:\n<approach>\nFirst, analyze the main research topic and identify:\n- Core research questions that need to be answered\n- Key domains/disciplines involved\n- Critical dependencies between different aspects\n- Potential knowledge gaps or challenges\n\nThen decompose the topic into ${teamSize} distinct, focused subproblems using these ORTHOGONALITY & DEPTH PRINCIPLES:\n</approach>\n\n<requirements>\nOrthogonality Requirements:\n- Each subproblem must address a fundamentally different aspect/dimension of the main topic\n- Use different decomposition axes (e.g., high-level, temporal, methodological, stakeholder-based, technical layers, side-effects, etc.)\n- Minimize subproblem overlap - if two subproblems share >20% of their scope, redesign them\n- Apply the "substitution test": removing any single subproblem should create a significant gap in understanding\n\nDepth Requirements:\n- Each subproblem should require 15-25 hours of focused research to properly address\n- Must go beyond surface-level information to explore underlying mechanisms, theories, or implications\n- Should generate insights that require synthesis of multiple sources and original analysis\n- Include both "what" and "why/how" questions to ensure analytical depth\n\nValidation Checks: Before finalizing assignments, verify:\nOrthogonality Matrix: Create a 2D matrix showing overlap between each pair of subproblems - aim for <20% overlap\nDepth Assessment: Each subproblem should have 4-6 layers of inquiry (surface → mechanisms → implications → future directions)\nCoverage Completeness: The union of all subproblems should address 90%+ of the main topic's scope\n</requirements>\n\nThe current time is ${currentTime.toISOString()}. Current year: ${currentYear}, current month: ${currentMonth}.\n\nStructure your response as valid JSON matching this exact schema. \nDo not include any text like (this subproblem is about ...) in the subproblems, use second person to describe the subproblems. Do not use the word "subproblem" or refer to other subproblems in the problem statement\nNow proceed with decomposing and assigning the research topic.`;

  const user = `\n${question}\n\n<soundbites>\n${soundBites}\n</soundbites>\n\n<think>`;

  const prompt = `${system}\n${user}`;
  const result = await simpleCompletion(prompt, { model, temperature: 0.3 });
  const response = result.content;

  try {
    return JSON.parse(response);
  } catch (err) {
    throw new Error('Failed to parse research plan JSON');
  }
}
