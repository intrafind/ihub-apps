// Unified Event Schema constants used for SSE communication
export const UnifiedEvents = {
  CONNECTED: 'connected',
  ERROR: 'error',
  DONE: 'done',
  SESSION_START: 'session.start',
  SESSION_END: 'session.end',
  CHUNK: 'chunk',
  TOOL_CALL_START: 'tool.call.start',
  TOOL_CALL_PROGRESS: 'tool.call.progress',
  TOOL_CALL_END: 'tool.call.end',
  CITATION: 'citation',
  SAFETY_WARNING: 'safety.warning'
};
