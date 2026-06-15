/**
 * Shared boolean-expression evaluator for workflow conditions.
 *
 * Used by:
 *   - DAGScheduler         (edge conditions of `type: "expression"`)
 *   - DecisionNodeExecutor (decision node config of `type: "expression"`)
 *
 * Strategy: a recursive-descent parser + tree-walking evaluator. **No
 * `eval` and no `new Function()`** — there is no way for input to reach a
 * code-execution sink. Operators and helper functions are evaluated by
 * concrete JS code paths.
 *
 * Supported grammar:
 *
 *   orExpr   := andExpr ('||' andExpr)*
 *   andExpr  := notExpr ('&&' notExpr)*
 *   notExpr  := '!'? cmpExpr
 *   cmpExpr  := value (('===' | '!==' | '==' | '!=' | '>=' | '<=' | '>' | '<') value)?
 *   value    := '(' orExpr ')' | helper '(' args ')' | path | literal
 *   helper   := 'exists' | 'empty' | 'length'
 *   path     := '$.' ident ('.' ident | '[' digit+ ']')*
 *   literal  := number | string ("'…'" | '"…"') | 'true' | 'false' | 'null' | 'undefined'
 *
 * `length($.x)` returns 0 when `$.x` is null/undefined or has no `.length`,
 * `exists($.x)` is true iff the value is not null/undefined,
 * `empty($.x)` is true for null/undefined/''/[].
 *
 * Strings are compared with JS `==`/`===` semantics — same as before. Path
 * lookups that don't resolve yield `undefined`.
 *
 * @module services/workflow/expressionEvaluator
 */

/* ───────────────────────── Path resolution ───────────────────────── */

/**
 * Resolve a `$.path` reference against the workflow state.
 *
 *   `$.data.field`             → state.data.field
 *   `$.nodeOutputs.node.field` → state.data.nodeResults[node].output.field
 *   `$.metadata.field`         → state.metadata.field
 *   Bracket array indices:     `items[0]`, `list[3].name`
 *
 * Returns `undefined` for any unresolved segment.
 */
export function resolvePath(path, state) {
  if (typeof path !== 'string' || !path.startsWith('$')) return undefined;
  const normalised = path.startsWith('$.') ? path.slice(2) : path.slice(1);
  if (!normalised) return undefined;

  const rawParts = normalised.split('.');
  let segments = rawParts;
  if (rawParts[0] === 'nodeOutputs' && rawParts.length >= 2) {
    segments = ['data', 'nodeResults', rawParts[1], 'output', ...rawParts.slice(2)];
  }

  let current = state;
  for (const part of segments) {
    if (current === null || current === undefined) return undefined;
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, name, idx] = arrayMatch;
      current = current[name];
      if (!Array.isArray(current)) return undefined;
      current = current[Number.parseInt(idx, 10)];
    } else {
      current = current[part];
    }
  }
  return current;
}

/* ───────────────────────── Tokenizer ────────────────────────────── */

const COMPARISON_OPERATORS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];
const HELPER_NAMES = new Set(['exists', 'empty', 'length']);
const LITERAL_KEYWORDS = {
  true: { type: 'literal', value: true },
  false: { type: 'literal', value: false },
  null: { type: 'literal', value: null },
  undefined: { type: 'literal', value: undefined }
};

class ExpressionError extends Error {}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Path: `$.foo.bar[2]`
    if (ch === '$' && source[i + 1] === '.') {
      const start = i;
      i += 2;
      while (i < len && /[\w.[\]]/.test(source[i])) i++;
      tokens.push({ type: 'path', value: source.slice(start, i) });
      continue;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let s = '';
      while (i < len && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < len) {
          s += source[i + 1];
          i += 2;
        } else {
          s += source[i++];
        }
      }
      if (i >= len) throw new ExpressionError(`Unterminated string starting at ${ch}`);
      i++; // closing quote
      tokens.push({ type: 'literal', value: s });
      continue;
    }

    // Number
    if (/\d/.test(ch) || (ch === '-' && /\d/.test(source[i + 1] || ''))) {
      const start = i;
      if (ch === '-') i++;
      while (i < len && /[\d.]/.test(source[i])) i++;
      const num = Number(source.slice(start, i));
      if (Number.isNaN(num)) throw new ExpressionError(`Invalid number: ${source.slice(start, i)}`);
      tokens.push({ type: 'literal', value: num });
      continue;
    }

    // Operators (longest-first)
    let matchedOp = null;
    for (const op of COMPARISON_OPERATORS) {
      if (source.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      tokens.push({ type: 'op', value: matchedOp });
      i += matchedOp.length;
      continue;
    }

    if (source.startsWith('&&', i)) {
      tokens.push({ type: 'and' });
      i += 2;
      continue;
    }
    if (source.startsWith('||', i)) {
      tokens.push({ type: 'or' });
      i += 2;
      continue;
    }
    if (ch === '!') {
      tokens.push({ type: 'not' });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }

    // Identifier — keywords (true/false/null/undefined) and helper names
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < len && /[\w]/.test(source[i])) i++;
      const word = source.slice(start, i);
      if (Object.prototype.hasOwnProperty.call(LITERAL_KEYWORDS, word)) {
        tokens.push(LITERAL_KEYWORDS[word]);
      } else if (HELPER_NAMES.has(word)) {
        tokens.push({ type: 'helper', value: word });
      } else {
        throw new ExpressionError(`Unknown identifier: ${word}`);
      }
      continue;
    }

    throw new ExpressionError(`Unexpected character: '${ch}' at ${i}`);
  }

  return tokens;
}

/* ───────────────────────── Parser (returns AST) ──────────────────── */

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.pos + offset];
  }
  consume(type) {
    const t = this.tokens[this.pos];
    if (!t || t.type !== type) {
      throw new ExpressionError(`Expected ${type} but got ${t ? t.type : 'end-of-input'}`);
    }
    this.pos++;
    return t;
  }
  match(type) {
    const t = this.tokens[this.pos];
    if (t && t.type === type) {
      this.pos++;
      return t;
    }
    return null;
  }
  done() {
    return this.pos >= this.tokens.length;
  }

  parse() {
    const node = this.parseOr();
    if (!this.done()) {
      const t = this.peek();
      throw new ExpressionError(`Unexpected trailing token: ${t?.type}`);
    }
    return node;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.match('or')) {
      const right = this.parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.match('and')) {
      const right = this.parseNot();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  parseNot() {
    if (this.match('not')) {
      return { kind: 'not', expr: this.parseNot() };
    }
    return this.parseComparison();
  }

  parseComparison() {
    const left = this.parseValue();
    const next = this.peek();
    if (next && next.type === 'op') {
      this.pos++;
      const right = this.parseValue();
      return { kind: 'cmp', op: next.value, left, right };
    }
    // Truthy coercion for a bare path/literal/helper as a condition.
    return { kind: 'truthy', expr: left };
  }

  parseValue() {
    const t = this.peek();
    if (!t) throw new ExpressionError('Unexpected end of expression');
    if (t.type === 'lparen') {
      this.pos++;
      const node = this.parseOr();
      this.consume('rparen');
      return node;
    }
    if (t.type === 'helper') {
      this.pos++;
      this.consume('lparen');
      const arg = this.parseValue();
      this.consume('rparen');
      return { kind: 'helper', name: t.value, arg };
    }
    if (t.type === 'path') {
      this.pos++;
      return { kind: 'path', path: t.value };
    }
    if (t.type === 'literal') {
      this.pos++;
      return { kind: 'literal', value: t.value };
    }
    throw new ExpressionError(`Unexpected token in value position: ${t.type}`);
  }
}

/* ───────────────────────── Evaluator (walks AST) ─────────────────── */

function valueOf(node, state) {
  switch (node.kind) {
    case 'path':
      return resolvePath(node.path, state);
    case 'literal':
      return node.value;
    case 'helper': {
      const v = valueOf(node.arg, state);
      switch (node.name) {
        case 'exists':
          return v !== null && v !== undefined;
        case 'empty':
          if (v === null || v === undefined || v === '') return true;
          if (Array.isArray(v) && v.length === 0) return true;
          if (typeof v === 'object' && Object.keys(v).length === 0) return true;
          return false;
        case 'length':
          if (v && typeof v.length === 'number') return v.length;
          if (v && typeof v === 'object') return Object.keys(v).length;
          return 0;
      }
      return undefined;
    }
    // Nested boolean expressions can appear as values (e.g. inside parens
    // used as the LHS/RHS of a comparison). Reduce to a boolean.
    case 'and':
    case 'or':
    case 'not':
    case 'cmp':
    case 'truthy':
      return evaluateNode(node, state);
    default:
      throw new ExpressionError(`Unknown value node: ${node.kind}`);
  }
}

function evaluateNode(node, state) {
  switch (node.kind) {
    case 'and':
      return evaluateNode(node.left, state) && evaluateNode(node.right, state);
    case 'or':
      return evaluateNode(node.left, state) || evaluateNode(node.right, state);
    case 'not':
      return !evaluateNode(node.expr, state);
    case 'cmp': {
      const l = valueOf(node.left, state);
      const r = valueOf(node.right, state);
      switch (node.op) {
        case '===':
          return l === r;
        case '!==':
          return l !== r;
        case '==':
          return l == r;
        case '!=':
          return l != r;
        case '>':
          return l > r;
        case '<':
          return l < r;
        case '>=':
          return l >= r;
        case '<=':
          return l <= r;
        default:
          throw new ExpressionError(`Unknown comparison op: ${node.op}`);
      }
    }
    case 'truthy':
      return Boolean(valueOf(node.expr, state));
    case 'helper':
    case 'path':
    case 'literal':
      return Boolean(valueOf(node, state));
    default:
      throw new ExpressionError(`Unknown node kind: ${node.kind}`);
  }
}

/* ───────────────────────── Public API ────────────────────────────── */

/**
 * Evaluate a boolean expression against workflow state.
 *
 * @param {string} expression
 * @param {Object} state Workflow state object — `.data`, `.metadata`, etc.
 * @returns {{ value: boolean, error?: string }}
 *   - `value`: the boolean result (false on empty or error)
 *   - `error`: human-readable error if evaluation failed
 */
export function evaluateBooleanExpression(expression, state) {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { value: false, error: 'empty-expression' };
  }

  try {
    const tokens = tokenize(expression);
    const ast = new Parser(tokens).parse();
    return { value: Boolean(evaluateNode(ast, state)) };
  } catch (error) {
    return { value: false, error: error.message };
  }
}

export default { evaluateBooleanExpression, resolvePath };
