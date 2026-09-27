/**
 * Pure helpers for the outbound A2A client: how a remote agent's skills become
 * iHub tool definitions, how A2A message parts become text, and how an SSE
 * stream of JSON-RPC responses is read. No I/O, no config — everything here
 * is unit-testable in isolation and shared by the connection, the manager and
 * the tool selection helpers.
 */

/** Prefix of every tool that maps to a remote A2A agent's skill. */
export const A2A_TOOL_PREFIX = 'a2a__';

/** Longest tool id a model provider accepts as a function name. */
export const MAX_TOOL_ID_LENGTH = 64;

/** Longest skill slug within a tool id. */
export const MAX_SKILL_SLUG_LENGTH = 40;

/** Task states after which a task never changes again (A2A 0.3 `TaskState`). */
export const FINAL_TASK_STATES = new Set(['completed', 'canceled', 'failed', 'rejected']);

/** Error codes the client attaches to thrown errors (`err.code`). */
export const A2A_CLIENT_ERRORS = Object.freeze({
  AUTH_FAILED: 'A2A_AUTH_FAILED',
  RPC_ERROR: 'A2A_RPC_ERROR',
  TASK_FAILED: 'A2A_TASK_FAILED',
  TIMEOUT: 'A2A_TIMEOUT',
  CARD_INVALID: 'A2A_CARD_INVALID',
  HTTP_ERROR: 'A2A_HTTP_ERROR'
});

/**
 * An Error carrying a machine-readable `code` (and optional extra fields) so
 * the chat's tool error envelope can surface it.
 *
 * @param {string} code - One of `A2A_CLIENT_ERRORS`
 * @param {string} message
 * @param {Object} [extra] - Extra fields copied onto the error
 * @returns {Error}
 */
export function a2aError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * The slug of a skill id inside a tool id: lower-cased, every run of
 * characters outside `[a-z0-9]` replaced by one underscore, trimmed of leading
 * and trailing underscores. Skill ids may contain spaces ("Ask Langdock
 * Agent" → `ask_langdock_agent`).
 *
 * @param {string} skillId
 * @returns {string}
 */
export function skillSlug(skillId) {
  return String(skillId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SKILL_SLUG_LENGTH);
}

/**
 * Whether a tool id belongs to a remote A2A agent.
 * @param {string} toolId
 * @returns {boolean}
 */
export function isA2aToolId(toolId) {
  return typeof toolId === 'string' && toolId.startsWith(A2A_TOOL_PREFIX);
}

/**
 * The model-facing description of a skill: its description (or name) plus its
 * examples, when the card lists any.
 *
 * @param {Object} skill - A2A `AgentSkill`
 * @returns {string}
 */
function skillDescription(skill) {
  const base = String(skill.description || skill.name || skill.id || '').trim();
  const examples = (Array.isArray(skill.examples) ? skill.examples : [])
    .filter(example => typeof example === 'string' && example.trim())
    .slice(0, 5);
  if (examples.length === 0) return base;
  const separator = !base ? '' : /[.!?]$/.test(base) ? ' ' : '. ';
  return `${base}${separator}Examples: ${examples.map(example => `"${example.trim()}"`).join('; ')}`;
}

/**
 * The tool definitions for an agent's skills, within its `allowedSkills`.
 *
 * Every tool takes the same input: a `message` for the agent and optional
 * structured `data` (sent as a data part). Ids are `a2a__<agentId>__<slug>`,
 * at most 64 characters, unique within the agent (a colliding slug gets a
 * numeric suffix).
 *
 * @param {Object} agentConfig - Parsed agent config (`a2aAgentConfigSchema`)
 * @param {Object} card - The agent's Agent Card
 * @returns {{tools: Array<Object>, skillsByToolId: Map<string, Object>}}
 */
export function buildSkillTools(agentConfig, card) {
  const allow = Array.isArray(agentConfig.allowedSkills) ? agentConfig.allowedSkills : ['*'];
  const allowAll = allow.includes('*');
  const prefix = `${A2A_TOOL_PREFIX}${agentConfig.id}__`;
  const budget = Math.max(1, Math.min(MAX_SKILL_SLUG_LENGTH, MAX_TOOL_ID_LENGTH - prefix.length));
  const used = new Set();
  const tools = [];
  const skillsByToolId = new Map();

  for (const skill of Array.isArray(card?.skills) ? card.skills : []) {
    if (!skill || typeof skill.id !== 'string' || !skill.id) continue;
    if (!allowAll && !allow.includes(skill.id)) continue;

    const base = skillSlug(skill.id).slice(0, budget) || 'skill';
    let slug = base;
    for (let n = 2; used.has(slug); n++) {
      const suffix = `_${n}`;
      slug = `${base.slice(0, Math.max(1, budget - suffix.length))}${suffix}`;
    }
    used.add(slug);

    const id = `${prefix}${slug}`;
    const tool = {
      id,
      name: id,
      description: skillDescription(skill),
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to ask the agent' },
          data: {
            type: 'object',
            description: 'Optional structured input (sent as a data part)',
            additionalProperties: true
          }
        },
        required: ['message']
      },
      // Internal marker so toolLoader.runTool and the tool pickers know the
      // owning agent; never sent to the model.
      _a2a: {
        agentId: agentConfig.id,
        agentName: agentConfig.name || agentConfig.id,
        skillId: skill.id,
        skillName: typeof skill.name === 'string' && skill.name ? skill.name : skill.id
      }
    };
    tools.push(tool);
    skillsByToolId.set(id, skill);
  }
  return { tools, skillsByToolId };
}

/**
 * The text of a list of A2A parts: text parts joined, then every data part
 * appended as JSON.
 *
 * @param {Array<Object>} parts
 * @param {Object} [options]
 * @param {string} [options.separator=''] - Between text parts (streamed chunks
 *   continue each other; a finished message's parts are paragraphs)
 * @returns {string}
 */
export function partsText(parts, { separator = '' } = {}) {
  const texts = [];
  const datas = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue;
    if (part.kind === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part.kind === 'data' && part.data !== undefined) {
      datas.push(JSON.stringify(part.data, null, 2));
    }
  }
  const text = texts.join(separator);
  if (datas.length === 0) return text;
  return [text, ...datas].filter(Boolean).join('\n');
}

/**
 * The text of a task's status message, if any.
 * @param {Object} task - A2A `Task` (or anything with `status.message`)
 * @returns {string}
 */
export function statusMessageText(task) {
  return partsText(task?.status?.message?.parts, { separator: '\n' }).trim();
}

/**
 * The text of a task's artifacts, joined as paragraphs.
 * @param {Array<Object>} artifacts - A2A `Artifact[]`
 * @returns {string}
 */
export function artifactsText(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .map(artifact => partsText(artifact?.parts))
    .filter(text => text.trim())
    .join('\n\n')
    .trim();
}

/**
 * Collects the events of one `message/stream` into the shape `tasks/get`
 * would return: artifacts (honouring `append` / `lastChunk`), the task, its
 * latest status and a direct `Message` reply.
 */
export class StreamCollector {
  constructor() {
    this.task = null;
    this.message = null;
    this.status = null;
    this.final = false;
    /** @type {Map<string, {artifactId: string, name?: string, text: string, done: boolean}>} */
    this.artifacts = new Map();
  }

  /**
   * Feed one stream event (the `result` of a JSON-RPC response).
   * @param {Object} event - Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent
   * @returns {{kind: string, state?: string, message?: string}|null} What changed
   */
  add(event) {
    if (!event || typeof event !== 'object') return null;
    switch (event.kind) {
      case 'task':
        this.task = event;
        if (event.status) this.status = event.status;
        if (Array.isArray(event.artifacts)) {
          for (const artifact of event.artifacts) this._replace(artifact);
        }
        if (FINAL_TASK_STATES.has(event.status?.state)) this.final = true;
        return { kind: 'task', state: event.status?.state };
      case 'message':
        this.message = event;
        this.final = true;
        return { kind: 'message' };
      case 'status-update':
        if (event.status) this.status = event.status;
        if (event.final === true) this.final = true;
        return {
          kind: 'status',
          state: event.status?.state,
          message: statusMessageText(event)
        };
      case 'artifact-update': {
        const artifact = event.artifact;
        if (!artifact || typeof artifact.artifactId !== 'string') return null;
        const existing = this.artifacts.get(artifact.artifactId);
        if (existing && event.append === true) {
          existing.text += partsText(artifact.parts);
          if (artifact.name && !existing.name) existing.name = artifact.name;
        } else {
          this._replace(artifact);
        }
        if (event.lastChunk === true) this.artifacts.get(artifact.artifactId).done = true;
        return { kind: 'artifact' };
      }
      default:
        return null;
    }
  }

  _replace(artifact) {
    if (!artifact || typeof artifact.artifactId !== 'string') return;
    this.artifacts.set(artifact.artifactId, {
      artifactId: artifact.artifactId,
      ...(artifact.name ? { name: artifact.name } : {}),
      text: partsText(artifact.parts),
      done: false
    });
  }

  /** The task id learned from the stream, if any. */
  get taskId() {
    return this.task?.id || this.status?.message?.taskId || null;
  }

  /** The context id learned from the stream, if any. */
  get contextId() {
    return this.task?.contextId || this.message?.contextId || null;
  }

  /** The collected artifacts as text, in arrival order. */
  artifactsText() {
    return Array.from(this.artifacts.values())
      .map(artifact => artifact.text)
      .filter(text => text.trim())
      .join('\n\n')
      .trim();
  }
}

/**
 * Read an SSE body (a web `ReadableStream`, an async iterable of bytes or
 * strings) and yield the JSON of every event's `data:` lines, the way the A2A
 * reference client does: `id:` and `event:` lines are ignored, comment lines
 * skipped, multi-line data joined with newlines, and a trailing event without
 * a blank line still delivered.
 *
 * @param {AsyncIterable<Uint8Array|string>} body
 * @returns {AsyncGenerator<Object>}
 */
export async function* parseSseStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];

  const flush = () => {
    if (data.length === 0) return undefined;
    const text = data.join('\n');
    data = [];
    return parseFrame(text);
  };
  const take = line => {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  };

  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const frame = flush();
        if (frame !== undefined) yield frame;
        continue;
      }
      if (line.startsWith(':')) continue;
      take(line);
    }
  }
  buffer += decoder.decode();
  const tail = buffer.replace(/\r$/, '');
  if (tail) take(tail);
  const last = flush();
  if (last !== undefined) yield last;
}

function parseFrame(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw a2aError(
      A2A_CLIENT_ERRORS.RPC_ERROR,
      `Invalid SSE frame from agent: ${err.message} (${text.slice(0, 80)})`
    );
  }
}

/**
 * Validate the parts of an Agent Card the client relies on.
 *
 * @param {unknown} card
 * @returns {Object} The card, with `capabilities.streaming` normalised
 * @throws {Error} `A2A_CARD_INVALID`
 */
export function validateAgentCard(card) {
  const invalid = why => a2aError(A2A_CLIENT_ERRORS.CARD_INVALID, `Invalid Agent Card: ${why}`);
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw invalid('not an object');
  if (typeof card.url !== 'string' || !/^https?:\/\//i.test(card.url)) {
    throw invalid('url must be an absolute http(s) URL');
  }
  if (!Array.isArray(card.skills)) throw invalid('skills must be an array');
  if (typeof card.protocolVersion !== 'string' || !card.protocolVersion) {
    throw invalid('protocolVersion is missing');
  }
  if (
    card.capabilities !== undefined &&
    (!card.capabilities || typeof card.capabilities !== 'object')
  ) {
    throw invalid('capabilities must be an object');
  }
  return {
    ...card,
    capabilities: { ...(card.capabilities || {}), streaming: card.capabilities?.streaming === true }
  };
}

/**
 * The JSON-RPC endpoint of an Agent Card: its `url` when the preferred
 * transport is JSON-RPC (the default), else the first JSON-RPC interface among
 * `additionalInterfaces`.
 *
 * @param {Object} card
 * @returns {string}
 * @throws {Error} `A2A_CARD_INVALID` when the card offers no JSON-RPC endpoint
 */
export function resolveRpcEndpoint(card) {
  const preferred = card.preferredTransport;
  if (
    preferred === undefined ||
    preferred === null ||
    String(preferred).toUpperCase() === 'JSONRPC'
  ) {
    return card.url;
  }
  const alternative = (
    Array.isArray(card.additionalInterfaces) ? card.additionalInterfaces : []
  ).find(
    entry =>
      String(entry?.transport || '').toUpperCase() === 'JSONRPC' && typeof entry.url === 'string'
  );
  if (!alternative) {
    throw a2aError(
      A2A_CLIENT_ERRORS.CARD_INVALID,
      `Agent Card offers no JSON-RPC interface (preferredTransport: ${preferred})`
    );
  }
  return alternative.url;
}

/**
 * The header name of the card's `apiKey` security scheme, when it declares one
 * sent as a header.
 *
 * @param {Object} card
 * @returns {string|null}
 */
export function cardApiKeyHeader(card) {
  const schemes = card?.securitySchemes;
  if (!schemes || typeof schemes !== 'object') return null;
  for (const scheme of Object.values(schemes)) {
    if (scheme?.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
      return scheme.name;
    }
  }
  return null;
}
