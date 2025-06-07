export function parseSSEBuffer(buffer) {
  const result = {
    events: [],
    done: false
  };

  if (!buffer) return result;

  // Split by newlines (single or double) as SSE events may be separated either way
  const lines = buffer.split(/\n+/);

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect completion marker
    if (trimmed === 'data: [DONE]' || trimmed === '[DONE]' || trimmed === 'data:[DONE]') {
      result.done = true;
      continue;
    }

    // Only process lines that start with 'data:'
    if (trimmed.startsWith('data:')) {
      const dataStr = trimmed.replace(/^data:\s*/, '');
      result.events.push(dataStr);
    }
  }

  return result;
}
