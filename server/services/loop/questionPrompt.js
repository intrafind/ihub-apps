/**
 * The `question` interaction prompt for an `ask_user` call: the tool's
 * arguments (client vocabulary for the input type) mapped onto the interaction
 * contract. Shared by the chat question seam and the workflow / agent node
 * question seam so both raise the identical kind.
 *
 * @module services/loop/questionPrompt
 */

const INPUT_TYPE_MAPPING = {
  select: 'single_select',
  multiselect: 'multi_select',
  confirm: 'confirm',
  text: 'text',
  number: 'number',
  date: 'date'
};

/**
 * @param {Object} args - `ask_user` arguments
 * @returns {Object} interaction `prompt`
 */
export function buildQuestionPrompt(args = {}) {
  const rawInputType = args.input_type || 'text';
  const prompt = {
    message: String(args.question ?? ''),
    inputType: INPUT_TYPE_MAPPING[rawInputType] || 'text',
    allowSkip: Boolean(args.allow_skip),
    allowOther: Boolean(args.allow_other)
  };
  if (Array.isArray(args.options) && args.options.length > 0) {
    prompt.options = args.options.map(opt => ({
      value: String(opt.value !== undefined ? opt.value : opt.label),
      label: String(opt.label ?? opt.value ?? '')
    }));
  }
  if (args.placeholder) prompt.placeholder = String(args.placeholder).substring(0, 200);
  if (args.validation && typeof args.validation === 'object') {
    prompt.validation = {};
    if (args.validation.pattern)
      prompt.validation.pattern = String(args.validation.pattern).slice(0, 200);
    if (args.validation.min !== undefined) prompt.validation.min = Number(args.validation.min);
    if (args.validation.max !== undefined) prompt.validation.max = Number(args.validation.max);
    if (args.validation.message) {
      prompt.validation.message = String(args.validation.message).substring(0, 200);
    }
  }
  if (args.context) prompt.context = String(args.context).substring(0, 500);
  return prompt;
}

export default buildQuestionPrompt;
