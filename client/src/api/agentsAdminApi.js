import { makeAdminApiCall } from './adminApi.js';

export async function fetchAgentProfiles() {
  return await makeAdminApiCall('/admin/agents/profiles');
}

export async function fetchAgentProfile(profileId) {
  return await makeAdminApiCall(`/admin/agents/profiles/${profileId}`);
}

export async function createAgentProfile(payload) {
  return await makeAdminApiCall('/admin/agents/profiles', {
    method: 'POST',
    body: payload
  });
}

export async function updateAgentProfile(profileId, payload) {
  return await makeAdminApiCall(`/admin/agents/profiles/${profileId}`, {
    method: 'PUT',
    body: payload
  });
}

export async function toggleAgentProfile(profileId) {
  return await makeAdminApiCall(`/admin/agents/profiles/${profileId}/toggle`, {
    method: 'POST'
  });
}

export async function deleteAgentProfile(profileId) {
  return await makeAdminApiCall(`/admin/agents/profiles/${profileId}`, {
    method: 'DELETE'
  });
}

export async function fetchAgentMemory(profileId) {
  return await makeAdminApiCall(`/admin/agents/profiles/${profileId}/memory`);
}

export async function writeAgentMemory(profileId, payload) {
  return await makeAdminApiCall(`/admin/agents/profiles/${profileId}/memory`, {
    method: 'PUT',
    body: payload
  });
}

/**
 * Run a registered tool with admin context and store its output as a named
 * section in the agent profile's long-term memory. Used for operator-driven
 * knowledge ingestion (e.g. running iFinder_discover to build a corpus map).
 *
 * When `shape` is true, the raw tool result is passed through an LLM call with
 * `shapePrompt` (`{TOOL_RESULT}` placeholder is substituted) and the LLM's
 * output is written to memory instead of the raw JSON dump. Use this to turn
 * verbose payloads into a compact, filterable index the agent can read.
 *
 * @param {string} profileId
 * @param {{
 *   toolId: string,
 *   params?: object,
 *   section: string,
 *   mode?: 'replace-section'|'append',
 *   shape?: boolean,
 *   shapePrompt?: string,
 *   shapeModel?: string
 * }} payload
 */
export async function buildMemoryFromTool(profileId, payload) {
  return await makeAdminApiCall(`/admin/agents/profiles/${profileId}/memory/from-tool`, {
    method: 'POST',
    body: payload
  });
}

export async function fetchMemoryShaperPrompt() {
  return await makeAdminApiCall('/admin/agents/memory/shaper-prompt');
}

export async function fetchInboxes() {
  return await makeAdminApiCall('/admin/agents/inboxes');
}

export async function fetchInbox(inboxId) {
  return await makeAdminApiCall(`/admin/agents/inboxes/${inboxId}`);
}

export async function createInbox(inboxId, body) {
  return await makeAdminApiCall(`/admin/agents/inboxes/${inboxId}`, {
    method: 'POST',
    body: { body }
  });
}

export async function writeInbox(inboxId, body, expectedVersion) {
  return await makeAdminApiCall(`/admin/agents/inboxes/${inboxId}`, {
    method: 'PUT',
    body: { body, expectedVersion }
  });
}

export async function addInboxItem(inboxId, item) {
  return await makeAdminApiCall(`/admin/agents/inboxes/${inboxId}/items`, {
    method: 'POST',
    body: item
  });
}

export async function triggerAgentRun(profileId, payload = {}) {
  return await makeAdminApiCall(`/agents/profiles/${profileId}/runs`, {
    method: 'POST',
    body: payload
  });
}

export async function fetchAgentRuns(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return await makeAdminApiCall(`/agents/runs${qs ? `?${qs}` : ''}`);
}

export async function fetchAgentRun(runId) {
  return await makeAdminApiCall(`/agents/runs/${runId}`);
}

export async function cancelAgentRun(runId, reason) {
  return await makeAdminApiCall(`/agents/runs/${runId}/cancel`, {
    method: 'POST',
    body: { reason }
  });
}

export async function resumeAgentRun(runId) {
  return await makeAdminApiCall(`/agents/runs/${runId}/resume`, {
    method: 'POST',
    body: {}
  });
}

export async function approveAgentRun(runId, payload) {
  return await makeAdminApiCall(`/agents/runs/${runId}/approve`, {
    method: 'POST',
    body: payload
  });
}

export async function fetchPendingApprovals() {
  return await makeAdminApiCall('/agents/approvals');
}

export async function fetchRunArtifacts(runId) {
  return await makeAdminApiCall(`/agents/runs/${runId}/artifacts`);
}
