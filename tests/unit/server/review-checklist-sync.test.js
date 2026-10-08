import { readFileSync } from 'fs';
import path from 'path';

/**
 * The review checklist exists twice: REVIEW.md, which Claude and CodeRabbit
 * read, and a copy for GitHub Copilot code review, which only reads files
 * under .github/instructions/. Pin the two copies together so a rule added
 * to one reaches every reviewer.
 */

const repoRoot = path.resolve(__dirname, '../../..');

function checklistFrom(relPath) {
  const source = readFileSync(path.join(repoRoot, relPath), 'utf8');
  const match = source.match(/<!-- checklist:start -->([\s\S]*?)<!-- checklist:end -->/);
  if (!match) throw new Error(`checklist markers not found in ${relPath}`);
  return match[1].trim();
}

describe('review checklist', () => {
  test('the Copilot instructions copy matches REVIEW.md exactly', () => {
    expect(checklistFrom('.github/instructions/review-checklist.instructions.md')).toEqual(
      checklistFrom('REVIEW.md')
    );
  });
});
