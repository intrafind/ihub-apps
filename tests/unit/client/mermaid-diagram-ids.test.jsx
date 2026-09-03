import { renderMarkdown } from '../../../client/src/config/marked.config';

const DIAGRAM = '```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```';
const OTHER_DIAGRAM = '```mermaid\nflowchart TD\n  X[One] --> Y[Two]\n```';

const idsIn = html => Array.from(html.matchAll(/id="(mermaid-[^"]+)"/g)).map(m => m[1]);

describe('mermaid diagram container ids', () => {
  test('are stable across repeated renders of the same markdown', () => {
    const first = renderMarkdown(DIAGRAM);
    const second = renderMarkdown(DIAGRAM);

    expect(idsIn(first)).toHaveLength(1);
    expect(idsIn(second)).toEqual(idsIn(first));
    // Identical markup means React leaves the already-rendered diagram alone
    // instead of recreating it on every re-render.
    expect(second).toEqual(first);
  });

  test('differ between different diagrams', () => {
    const [firstId] = idsIn(renderMarkdown(DIAGRAM));
    const [secondId] = idsIn(renderMarkdown(OTHER_DIAGRAM));

    expect(firstId).not.toEqual(secondId);
  });

  test('stay unique when the same diagram appears twice in one document', () => {
    const html = renderMarkdown(`${DIAGRAM}\n\n${DIAGRAM}`);
    const ids = idsIn(html);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('do not drift when a document with duplicates is re-rendered', () => {
    const source = `${DIAGRAM}\n\n${DIAGRAM}`;

    expect(idsIn(renderMarkdown(source))).toEqual(idsIn(renderMarkdown(source)));
  });

  test('are unaffected by unrelated renders in between', () => {
    const before = idsIn(renderMarkdown(DIAGRAM));
    renderMarkdown(OTHER_DIAGRAM);
    renderMarkdown('# just a heading');
    const after = idsIn(renderMarkdown(DIAGRAM));

    expect(after).toEqual(before);
  });
});
