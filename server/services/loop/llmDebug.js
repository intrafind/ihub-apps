/**
 * Operator diagnostics for LLM requests (ported from WorkflowLLMHelper):
 *
 *   - `LLM_DEBUG_DUMP_ALL=1` dumps every outbound request body to
 *     `contents/data/debug/llm-request/` before it is sent
 *   - non-transient 4xx failures dump request + response to
 *     `contents/data/debug/llm-failures/` and log a shape summary
 *
 * Secrets in URLs / auth headers are redacted. Everything here is best-effort
 * and must never mask the real LLM error.
 *
 * @module services/loop/llmDebug
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRootDir } from '../../pathUtils.js';
import config from '../../config.js';

export function isDumpAllEnabled() {
  return process.env.LLM_DEBUG_DUMP_ALL === '1';
}

function redactUrl(url) {
  return typeof url === 'string' ? url.replace(/key=[^&]+/i, 'key=REDACTED') : null;
}

function redactHeaders(headers) {
  const out = { ...(headers || {}) };
  for (const k of Object.keys(out)) {
    if (/auth|api[-_]?key|bearer|token/i.test(k)) out[k] = 'REDACTED';
  }
  return out;
}

/**
 * Write a dump of the outbound request (and optionally the response) to
 * `contents/data/debug/llm-{bucket}/<ts>-<modelId>-<status>.json`.
 * @returns {Promise<string>} absolute path of the written file
 */
export async function dumpRequest(request, model, bucket, extra = {}) {
  const dir = path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'debug', `llm-${bucket}`);
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeModelId = String(model?.id || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const statusSuffix = extra.response?.status ? `-${extra.response.status}` : '';
  const file = path.join(dir, `${ts}-${safeModelId}${statusSuffix}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        model: { id: model?.id, provider: model?.provider, modelId: model?.modelId },
        request: {
          url: redactUrl(request?.url),
          method: request?.method || 'POST',
          headers: redactHeaders(request?.headers),
          body: request?.body
        },
        ...(extra.response ? { response: extra.response } : {})
      },
      null,
      2
    )
  );
  return file;
}

/**
 * Summarize the shape of a provider request body (sizes/keys, no prompt text)
 * so a generic 4xx can be diagnosed from logs without leaking content.
 * Covers OpenAI-style `messages` and Google-style `contents`.
 */
export function summarizeRequestShape(body = {}) {
  try {
    const summarizeMessage = m => ({
      role: m?.role,
      contentType: typeof m?.content,
      contentLength:
        typeof m?.content === 'string'
          ? m.content.length
          : Array.isArray(m?.content)
            ? m.content.length
            : null,
      contentPartsShape: Array.isArray(m?.content)
        ? m.content.map(p => ({
            type: p?.type,
            textLength: typeof p?.text === 'string' ? p.text.length : null,
            hasImageUrl: !!p?.image_url
          }))
        : undefined,
      hasToolCalls: Array.isArray(m?.tool_calls) && m.tool_calls.length > 0 ? true : undefined
    });
    const messages = Array.isArray(body.messages) ? body.messages.map(summarizeMessage) : null;
    const contents = Array.isArray(body.contents)
      ? body.contents.map(c => ({
          role: c?.role,
          partsCount: Array.isArray(c?.parts) ? c.parts.length : 0,
          partsShape: Array.isArray(c?.parts)
            ? c.parts.map(p => ({
                keys: p ? Object.keys(p) : [],
                textLength: typeof p?.text === 'string' ? p.text.length : null,
                inlineDataMimeType: p?.inlineData?.mimeType,
                inlineDataLength: p?.inlineData?.data?.length
              }))
            : undefined
        }))
      : null;
    const sysInst = body.systemInstruction;
    return {
      topLevelKeys: Object.keys(body),
      model: body.model,
      stream: body.stream,
      maxTokens: body.max_tokens || body.generationConfig?.maxOutputTokens,
      temperature: body.temperature || body.generationConfig?.temperature,
      thinkingConfig: body.generationConfig?.thinkingConfig,
      hasTools: Array.isArray(body.tools) && body.tools.length > 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      hasResponseFormat: !!body.response_format,
      responseFormatType: body.response_format?.type,
      hasResponseSchema: !!body.generationConfig?.responseSchema,
      messageCount: messages?.length,
      messages,
      contentsCount: contents?.length,
      contents,
      systemInstructionLength:
        typeof sysInst?.parts?.[0]?.text === 'string'
          ? sysInst.parts[0].text.length
          : typeof sysInst === 'string'
            ? sysInst.length
            : null,
      bodyJsonLength: JSON.stringify(body).length
    };
  } catch (err) {
    return { shapeBuildError: err.message };
  }
}
