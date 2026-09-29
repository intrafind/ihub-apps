import { isAllowedAgentUrl } from '../../validators/a2aAgentConfigSchema.js';

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

/**
 * What OpenAI and Anthropic accept as a function (tool) name. Every A2A tool
 * id has to match it, or the provider rejects the whole chat request.
 */
export const PROVIDER_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Size limits for what a remote agent sends back. The model only ever sees a
 * bounded preview of a tool result, so anything beyond these is a misbehaving
 * (or hostile) agent that would otherwise grow the worker's heap.
 */
export const A2A_RESPONSE_LIMITS = Object.freeze({
  /** Agent Card body. */
  cardBytes: 1024 * 1024,
  /** A JSON-RPC response body (`message/send`, `tasks/get`, OAuth token). */
  jsonBytes: 4 * 1024 * 1024,
  /** One SSE line, and the `data:` lines of one SSE event together. */
  sseEventBytes: 4 * 1024 * 1024,
  /** Everything one `message/stream` response may deliver. */
  streamBytes: 16 * 1024 * 1024,
  /** The artifact text collected from one stream, in characters. */
  artifactChars: 4 * 1024 * 1024
});

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
  HTTP_ERROR: 'A2A_HTTP_ERROR',
  /** The agent answered with a 3xx; A2A requests never follow redirects. */
  REDIRECT_REFUSED: 'A2A_REDIRECT_REFUSED',
  /** A response exceeded one of `A2A_RESPONSE_LIMITS`. */
  RESPONSE_TOO_LARGE: 'A2A_RESPONSE_TOO_LARGE',
  /** The task stopped at `auth-required`: the agent wants credentials iHub cannot give. */
  AUTH_REQUIRED: 'A2A_AUTH_REQUIRED',
  /** The chat turn was stopped by the user while the agent was working. */
  CANCELLED: 'A2A_CANCELLED'
});

/**
 * Task states in which a task keeps working on its own; every other state
 * (final, interrupted, `unknown`, or one iHub does not know) needs no more
 * polling.
 */
export const RUNNING_TASK_STATES = new Set(['submitted', 'working']);

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
 * The slug of every skill id on a card, unique within the card.
 *
 * Slugs are handed out over *all* the card's skills, sorted by skill id, so a
 * skill's slug (and with it its tool id) does not depend on the agent's
 * `allowedSkills` or on the order the card lists its skills in: the admin
 * preview (all skills) and the runtime (allowed skills) name a skill alike.
 * Two skill ids that slug alike ("Ask Agent", "ask-agent") get a numeric
 * suffix in skill-id order.
 *
 * @param {string[]} skillIds - The card's skill ids
 * @param {number} budget - Longest slug allowed
 * @returns {Map<string, string>} skill id → slug
 */
function assignSkillSlugs(skillIds, budget) {
  const sorted = Array.from(new Set(skillIds)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const used = new Set();
  const slugs = new Map();
  for (const skillId of sorted) {
    const base = skillSlug(skillId).slice(0, budget) || 'skill';
    let slug = base;
    for (let n = 2; used.has(slug); n++) {
      const suffix = `_${n}`;
      slug = `${base.slice(0, Math.max(1, budget - suffix.length))}${suffix}`;
    }
    used.add(slug);
    slugs.set(skillId, slug);
  }
  return slugs;
}

/**
 * The tool definitions for an agent's skills, within its `allowedSkills`.
 *
 * Every tool takes the same input: a `message` for the agent and optional
 * structured `data` (sent as a data part). Ids are `a2a__<agentId>__<slug>`,
 * at most 64 characters, match `PROVIDER_TOOL_NAME_PATTERN`, and are unique
 * within the agent (see `assignSkillSlugs` for how clashing slugs are told
 * apart). An agent id that cannot form a valid tool name yields no tools.
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
  const tools = [];
  const skillsByToolId = new Map();

  const skills = (Array.isArray(card?.skills) ? card.skills : []).filter(
    skill => skill && typeof skill.id === 'string' && skill.id
  );
  const slugs = assignSkillSlugs(
    skills.map(skill => skill.id),
    budget
  );
  const seen = new Set();

  for (const skill of skills) {
    if (seen.has(skill.id)) continue; // a card listing one skill id twice
    seen.add(skill.id);
    if (!allowAll && !allow.includes(skill.id)) continue;

    const id = `${prefix}${slugs.get(skill.id)}`;
    // The schema keeps agent ids to what a provider accepts; a hand-edited id
    // that slipped past it must not break every chat request of the app.
    if (!PROVIDER_TOOL_NAME_PATTERN.test(id)) continue;
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
  /**
   * @param {Object} [options]
   * @param {number} [options.maxArtifactChars] - Most artifact text collected
   *   before the stream is refused (`A2A_RESPONSE_TOO_LARGE`)
   */
  constructor({ maxArtifactChars = A2A_RESPONSE_LIMITS.artifactChars } = {}) {
    this.task = null;
    this.message = null;
    this.status = null;
    this.final = false;
    /** @type {Map<string, {artifactId: string, name?: string, text: string, done: boolean}>} */
    this.artifacts = new Map();
    this.maxArtifactChars = maxArtifactChars;
    this._artifactChars = 0;
    // Learned from the first event that names them: `TaskStatusUpdateEvent`
    // and `TaskArtifactUpdateEvent` carry `taskId` / `contextId` themselves,
    // and agents such as Google ADK never send a `Task` event at all.
    this._taskId = null;
    this._contextId = null;
  }

  /**
   * Whether an event belongs to the task this stream is about. The first
   * event that names a task (or context) decides; a later event naming
   * another one is ignored, so a confused or hostile agent cannot mix a
   * different task's status or artifacts into this answer.
   */
  _belongs(taskId, contextId) {
    const knownTask = this.taskId;
    const knownContext = this.contextId;
    if (knownTask && typeof taskId === 'string' && taskId && taskId !== knownTask) return false;
    if (knownContext && typeof contextId === 'string' && contextId && contextId !== knownContext) {
      return false;
    }
    return true;
  }

  _learn(taskId, contextId) {
    if (!this._taskId && typeof taskId === 'string' && taskId) this._taskId = taskId;
    if (!this._contextId && typeof contextId === 'string' && contextId) {
      this._contextId = contextId;
    }
  }

  /**
   * Feed one stream event (the `result` of a JSON-RPC response). Events of
   * another task or context than the stream's are ignored (returns null).
   *
   * @param {Object} event - Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent
   * @returns {{kind: string, state?: string, message?: string}|null} What changed
   * @throws {Error} `A2A_RESPONSE_TOO_LARGE` when the artifacts outgrow `maxArtifactChars`
   */
  add(event) {
    if (!event || typeof event !== 'object') return null;
    const taskId = event.kind === 'task' ? event.id : event.taskId;
    if (!this._belongs(taskId, event.contextId)) return null;
    this._learn(taskId, event.contextId);
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
          const chunk = partsText(artifact.parts);
          this._count(chunk.length);
          existing.text += chunk;
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
    const text = partsText(artifact.parts);
    const previous = this.artifacts.get(artifact.artifactId);
    this._count(text.length - (previous ? previous.text.length : 0));
    this.artifacts.set(artifact.artifactId, {
      artifactId: artifact.artifactId,
      ...(artifact.name ? { name: artifact.name } : {}),
      text,
      done: false
    });
  }

  /** Account for `delta` more characters of artifact text; refuse past the cap. */
  _count(delta) {
    this._artifactChars += delta;
    if (this._artifactChars > this.maxArtifactChars) {
      throw a2aError(
        A2A_CLIENT_ERRORS.RESPONSE_TOO_LARGE,
        `Agent sent more than ${this.maxArtifactChars} characters of artifact text`
      );
    }
  }

  /** The task id learned from the stream, if any. */
  get taskId() {
    return this.task?.id || this._taskId || this.status?.message?.taskId || null;
  }

  /** The context id learned from the stream, if any. */
  get contextId() {
    return this.task?.contextId || this._contextId || this.message?.contextId || null;
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
 * The stream is bounded: a line or an event larger than `maxEventBytes`, or a
 * body larger than `maxTotalBytes`, ends it with `A2A_RESPONSE_TOO_LARGE`
 * (the caller's `for await` then cancels the underlying body).
 *
 * @param {AsyncIterable<Uint8Array|string>} body
 * @param {Object} [limits]
 * @param {number} [limits.maxEventBytes]
 * @param {number} [limits.maxTotalBytes]
 * @returns {AsyncGenerator<Object>}
 */
export async function* parseSseStream(
  body,
  {
    maxEventBytes = A2A_RESPONSE_LIMITS.sseEventBytes,
    maxTotalBytes = A2A_RESPONSE_LIMITS.streamBytes
  } = {}
) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let dataSize = 0;
  let total = 0;
  const tooLarge = what => a2aError(A2A_CLIENT_ERRORS.RESPONSE_TOO_LARGE, `Agent stream ${what}`);

  const flush = () => {
    if (data.length === 0) return undefined;
    const text = data.join('\n');
    data = [];
    dataSize = 0;
    return parseFrame(text);
  };
  const take = line => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).replace(/^ /, '');
    dataSize += value.length + 1;
    if (dataSize > maxEventBytes) {
      throw tooLarge(`sent an event larger than ${maxEventBytes} bytes`);
    }
    data.push(value);
  };

  for await (const chunk of body) {
    total += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    if (total > maxTotalBytes) throw tooLarge(`sent more than ${maxTotalBytes} bytes`);
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
    // What is left has no newline yet; it must not grow without bound.
    if (buffer.length > maxEventBytes) {
      throw tooLarge(`sent a line longer than ${maxEventBytes} bytes`);
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
 * Every request to the endpoint carries the agent's credential and the user's
 * message, so it has to satisfy the same rule as the configured `cardUrl`:
 * HTTPS, plain HTTP for a loopback host only (`isAllowedAgentUrl`).
 *
 * @param {Object} card
 * @returns {string}
 * @throws {Error} `A2A_CARD_INVALID` when the card offers no JSON-RPC endpoint,
 *   or one that is neither HTTPS nor loopback HTTP
 */
export function resolveRpcEndpoint(card) {
  const endpoint = jsonRpcUrlOf(card);
  if (!isAllowedAgentUrl(endpoint)) {
    throw a2aError(
      A2A_CLIENT_ERRORS.CARD_INVALID,
      `Agent Card names a JSON-RPC endpoint that is not HTTPS (${endpoint}); plain HTTP is allowed for localhost only`
    );
  }
  return endpoint;
}

function jsonRpcUrlOf(card) {
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

/**
 * The references that select a tool that is *not* a remote A2A agent's skill,
 * the way `isToolSelected` reads them: its id, its base id (`jira` for
 * `jira_searchTickets`) and, for a tool of an MCP server, the server's id.
 *
 * @param {{id: string, _a2a?: Object, _mcp?: {serverId?: string}}} tool
 * @returns {string[]}
 */
export function nonAgentToolRefs(tool) {
  if (!tool?.id || tool._a2a || isA2aToolId(tool.id)) return [];
  const refs = [tool.id];
  if (tool.id.includes('_')) refs.push(tool.id.split('_')[0]);
  if (tool._mcp?.serverId) refs.push(tool._mcp.serverId);
  return refs;
}

/**
 * What an A2A agent id would clash with. Apps and groups select a whole agent
 * by its id, and the very same reference also selects a local tool (by id or
 * base id) or an MCP server (by id) — so an agent `jira` would silently be
 * granted to every app that lists `jira` for the local Jira tools. Compared
 * case-insensitively, like group grants.
 *
 * @param {string} agentId
 * @param {Object} [taken]
 * @param {Array<Object>} [taken.tools] - Local and discovered tool definitions
 * @param {Array<{id: string, toolPrefix?: string}>} [taken.mcpServers] - Configured MCP servers
 * @returns {{kind: 'tool'|'mcpServer', id: string}|null} The first clash, or null
 *
 * @example
 *   findAgentIdConflict('jira', { tools: [{ id: 'jira_searchTickets' }] });
 *   // → { kind: 'tool', id: 'jira_searchTickets' }
 */
export function findAgentIdConflict(agentId, { tools = [], mcpServers = [] } = {}) {
  if (typeof agentId !== 'string' || !agentId) return null;
  const wanted = agentId.toLowerCase();
  for (const server of mcpServers || []) {
    if (typeof server?.id !== 'string') continue;
    // A custom `toolPrefix` (`dio_`) gives the server's tools another base id.
    const prefixBase =
      typeof server.toolPrefix === 'string' && server.toolPrefix.trim()
        ? server.toolPrefix.trim().split('_')[0]
        : null;
    if (server.id.toLowerCase() === wanted || prefixBase?.toLowerCase() === wanted) {
      return { kind: 'mcpServer', id: server.id };
    }
  }
  for (const tool of tools || []) {
    if (nonAgentToolRefs(tool).some(ref => ref.toLowerCase() === wanted)) {
      return tool._mcp?.serverId
        ? { kind: 'mcpServer', id: tool._mcp.serverId }
        : { kind: 'tool', id: tool.id };
    }
  }
  return null;
}

/**
 * Mark the A2A tools whose agent id clashes with a local tool or an MCP
 * server (`_a2a.idConflict: true`). `isToolSelected` then no longer selects
 * them by the agent id: the ambiguous reference keeps meaning the local tool
 * or MCP server, and the agent is selected by `a2a__<agentId>` (or its skills'
 * exact tool ids). The admin API refuses such ids; this guards a hand-edited config and
 * a tool or MCP server added after the agent.
 *
 * @param {Array<Object>} a2aTools - Tools carrying `_a2a`
 * @param {Object} taken - As for `findAgentIdConflict`
 * @returns {{tools: Array<Object>, conflicts: Map<string, {kind: string, id: string}>}}
 *   The tools (clashing ones copied with the marker, the others unchanged) and
 *   the clash per affected agent id
 */
export function markAgentIdConflicts(a2aTools, taken) {
  const found = new Map();
  const tools = (a2aTools || []).map(tool => {
    const agentId = tool?._a2a?.agentId;
    if (!agentId) return tool;
    if (!found.has(agentId)) found.set(agentId, findAgentIdConflict(agentId, taken));
    return found.get(agentId) ? { ...tool, _a2a: { ...tool._a2a, idConflict: true } } : tool;
  });
  const conflicts = new Map([...found].filter(([, conflict]) => conflict));
  return { tools, conflicts };
}
