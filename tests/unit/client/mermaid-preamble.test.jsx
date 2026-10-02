import { validateMermaidCode, detectDiagramType } from '../../../client/src/utils/markdownHelpers';

const PIE = 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85';
const GANTT = 'gantt\n  title Plan\n  section A\n  Task1 :a1, 2024-01-01, 30d';
const MINDMAP = 'mindmap\n  root((iHub))\n    A\n    B';

const FRONTMATTER = '---\nconfig:\n  theme: base\n  themeVariables:\n    pie1: "#E30613"\n---\n';
const INIT_DIRECTIVE = "%%{init: {'theme': 'base', 'themeVariables': {'pie1': '#E30613'}}}%%\n";
const MULTILINE_DIRECTIVE = "%%{\n  init: {\n    'theme': 'base'\n  }\n}%%\n";

describe('mermaid diagrams with a theme preamble', () => {
  test.each([
    ['front matter', FRONTMATTER],
    ['an init directive', INIT_DIRECTIVE],
    ['a multi-line init directive', MULTILINE_DIRECTIVE],
    ['a comment and an init directive', `%% corporate colours\n${INIT_DIRECTIVE}`],
    ['front matter followed by an init directive', `${FRONTMATTER}${INIT_DIRECTIVE}`],
    ['Windows line endings', FRONTMATTER.replace(/\n/g, '\r\n')]
  ])('are accepted with %s', (_label, preamble) => {
    for (const diagram of [PIE, GANTT, MINDMAP]) {
      expect(validateMermaidCode(`${preamble}${diagram}`)).toBe(true);
    }
  });

  test('keep their detected diagram type', () => {
    expect(detectDiagramType(`${FRONTMATTER}${PIE}`)).toBe('pie');
    expect(detectDiagramType(`${INIT_DIRECTIVE}${GANTT}`)).toBe('gantt');
    expect(detectDiagramType(`${MULTILINE_DIRECTIVE}${MINDMAP}`)).toBe('mindmap');
  });

  test('are still rejected when only the preamble is present', () => {
    expect(validateMermaidCode(FRONTMATTER)).toBe(false);
    expect(validateMermaidCode(INIT_DIRECTIVE)).toBe(false);
  });

  test('are still rejected when the diagram itself is incomplete', () => {
    expect(validateMermaidCode(`${FRONTMATTER}pie`)).toBe(false);
    expect(validateMermaidCode(`${INIT_DIRECTIVE}flowchart TD\n  A[Start] -->`)).toBe(false);
  });

  test('leave diagrams without a preamble unchanged', () => {
    expect(validateMermaidCode(PIE)).toBe(true);
    expect(validateMermaidCode('flowchart TD\n  A[Start] --> B[End]')).toBe(true);
    expect(detectDiagramType(PIE)).toBe('pie');
  });
});
