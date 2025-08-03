// Define maps once at the module level for performance
const LANGUAGE_DISPLAY_MAP = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  python: 'Python',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  cs: 'C#',
  php: 'PHP',
  rb: 'Ruby',
  ruby: 'Ruby',
  go: 'Go',
  rust: 'Rust',
  swift: 'Swift',
  kotlin: 'Kotlin',
  scala: 'Scala',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  xml: 'XML',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  fish: 'Fish',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  sql: 'SQL',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  r: 'R',
  matlab: 'MATLAB',
  perl: 'Perl',
  lua: 'Lua',
  dart: 'Dart',
  elm: 'Elm',
  clojure: 'Clojure',
  erlang: 'Erlang',
  elixir: 'Elixir',
  haskell: 'Haskell',
  ocaml: 'OCaml',
  fsharp: 'F#',
  fs: 'F#',
  vb: 'Visual Basic',
  vba: 'VBA',
  text: 'Text',
  txt: 'Text',
  md: 'Markdown',
  markdown: 'Markdown',
  tex: 'LaTeX',
  latex: 'LaTeX',
  diff: 'Diff',
  patch: 'Patch',
  mermaid: 'Mermaid',
  diagram: 'Diagram',
  graph: 'Graph'
};

const FILE_EXTENSION_MAP = {
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  cs: 'cs',
  php: 'php',
  ruby: 'rb',
  rb: 'rb',
  go: 'go',
  rust: 'rs',
  swift: 'swift',
  kotlin: 'kt',
  scala: 'scala',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  ini: 'ini',
  sh: 'sh',
  bash: 'sh',
  zsh: 'zsh',
  fish: 'fish',
  powershell: 'ps1',
  ps1: 'ps1',
  sql: 'sql',
  mysql: 'sql',
  postgresql: 'sql',
  sqlite: 'sql',
  r: 'r',
  matlab: 'm',
  perl: 'pl',
  lua: 'lua',
  dart: 'dart',
  elm: 'elm',
  clojure: 'clj',
  erlang: 'erl',
  elixir: 'ex',
  haskell: 'hs',
  ocaml: 'ml',
  fsharp: 'fs',
  fs: 'fs',
  vb: 'vb',
  vba: 'vba',
  markdown: 'md',
  md: 'md',
  tex: 'tex',
  latex: 'tex',
  diff: 'diff',
  patch: 'patch',
  text: 'txt',
  mermaid: 'mmd',
  diagram: 'mmd',
  graph: 'mmd'
};

const MERMAID_LANGUAGES = new Set([
  'mermaid',
  'diagram',
  'graph',
  'flowchart',
  'sequence',
  'class',
  'state',
  'gantt',
  'pie',
  'journey',
  'timeline',
  'mindmap',
  'mind-map',
  'gitgraph',
  'er',
  'quadrant'
]);

export const getLanguageDisplayName = (language = 'text') => {
  const lang = language.toLowerCase();
  return LANGUAGE_DISPLAY_MAP[lang] || language.toUpperCase();
};

export const getFileExtension = (language = 'text') => {
  const lang = language.toLowerCase();
  return FILE_EXTENSION_MAP[lang] || 'txt';
};

export const isMermaidLanguage = language => {
  if (!language) return false;
  return MERMAID_LANGUAGES.has(language.toLowerCase());
};

export const validateMermaidCode = code => {
  if (!code || typeof code !== 'string') return false;

  const trimmedCode = code.trim();
  if (trimmedCode.length < 10) return false; // Too short to be meaningful

  // Check for obvious incomplete patterns
  const incompletePatterns = [
    /-->\s*$/, // Ends with arrow pointing nowhere
    /^\s*\w+\s*$/, // Just a single word
    /:\s*$/, // Ends with colon (incomplete label)
    /\[\s*$/, // Ends with opening bracket
    /\(\s*$/, // Ends with opening parenthesis
    /{\s*$/ // Ends with opening brace
  ];

  // If code matches any incomplete pattern, it's likely partial
  if (incompletePatterns.some(pattern => pattern.test(trimmedCode))) {
    return false;
  }

  // Check for basic diagram structure
  const lines = trimmedCode.split('\n').filter(line => line.trim());
  if (lines.length < 2) return false; // Needs at least diagram type + content

  // Check if it has a diagram type declaration or common diagram patterns
  const hasValidStart =
    /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|timeline|mindmap|gitgraph|quadrantChart)/i.test(
      lines[0]
    ) ||
    trimmedCode.includes('-->') ||
    trimmedCode.includes('->') ||
    trimmedCode.includes('participant') ||
    trimmedCode.includes('class ') ||
    trimmedCode.includes('state ');

  return hasValidStart;
};

export const processMermaidCode = code => {
  let processedCode = code;

  // Convert <br> tags to newlines for Mermaid
  if (code.includes('<br>') || code.includes('<br/>') || code.includes('<br />')) {
    // First replace <br> tags with newlines
    processedCode = code.replace(/<br\s*\/?>/gi, '\n');

    // Then handle square bracket labels that now have newlines
    // Use a more specific regex that handles the full node syntax
    processedCode = processedCode.replace(
      /(\w+)(\[)([^\]]+)(\])/g,
      (match, nodeId, openBracket, content) => {
        // If content has newlines, wrap in quotes
        if (content.includes('\n')) {
          return `${nodeId}["${content.trim()}"]`;
        }
        return match;
      }
    );
  }

  // Clean up common syntax errors
  // Remove duplicate node IDs at the end of arrow lines
  processedCode = processedCode.replace(/(\w+\s*-->\s*\w+\[[^\]]+\])\s+\1/g, '$1');
  processedCode = processedCode.replace(/(\w+\s*-->\s*\w+\[[^\]]+\])\s+(\w+)$/gm, '$1');

  // Remove trailing node IDs that appear after complete arrow statements
  processedCode = processedCode
    .split('\n')
    .map(line => {
      // Check if line has arrow and ends with just a node ID
      if (line.includes('-->') && /\]\s+[A-Z]\d*\s*$/.test(line)) {
        return line.replace(/\]\s+[A-Z]\d*\s*$/, ']');
      }
      return line;
    })
    .join('\n');

  return processedCode;
};

export const detectDiagramType = code => {
  const trimmedCode = code.trim();
  const lines = trimmedCode.split('\n');
  const firstLine = lines[0]?.trim().toLowerCase() || '';

  // Check for explicit diagram type declarations
  if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph')) return 'flowchart';
  if (firstLine === 'mindmap') return 'mindmap';
  if (firstLine.startsWith('sequencediagram') || firstLine.startsWith('sequence'))
    return 'sequence';
  if (firstLine.startsWith('classDiagram') || firstLine.startsWith('class')) return 'class';
  if (firstLine.startsWith('stateDiagram') || firstLine.startsWith('state')) return 'state';
  if (firstLine.startsWith('gantt')) return 'gantt';
  if (firstLine.startsWith('pie')) return 'pie';
  if (firstLine.startsWith('journey')) return 'journey';
  if (firstLine.startsWith('timeline')) return 'timeline';
  if (firstLine.startsWith('gitgraph')) return 'gitgraph';
  if (firstLine.startsWith('erdiagram') || firstLine.startsWith('er')) return 'er';
  if (firstLine.startsWith('quadrantchart') || firstLine.startsWith('quadrant')) return 'quadrant';

  // Fallback detection based on syntax patterns
  if (trimmedCode.includes('-->') || trimmedCode.includes('---')) return 'flowchart';
  if (
    lines.length > 1 &&
    lines
      .slice(1)
      .some(line => line.trim() && !line.trim().includes('-->') && !line.trim().includes('---'))
  ) {
    // If content has indentation-based structure without arrows, likely mindmap
    const hasIndentedContent = lines
      .slice(1)
      .some(line => line.startsWith('    ') || line.startsWith('\t'));
    if (hasIndentedContent) return 'mindmap';
  }

  return 'flowchart'; // Default fallback
};

// Helper to generate a unique-ish ID without Math.random() issues
export const generateId = () =>
  `id-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
