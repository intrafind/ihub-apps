export function normalizeName(name) {
  return (name || '').replace(/[^A-Za-z0-9_]/g, '_');
}

export function formatToolsForOpenAI(tools = []) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: normalizeName(t.id || t.name),
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} }
    }
  }));
}

export function formatToolsForAnthropic(tools = []) {
  return tools.map(t => ({
    name: normalizeName(t.id || t.name),
    description: t.description || '',
    input_schema: t.parameters || { type: 'object', properties: {} }
  }));
}

export function formatToolsForGoogle(tools = []) {
  return [{
    functionDeclarations: tools.map(t => ({
      name: normalizeName(t.id || t.name),
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} }
    }))
  }];
}
