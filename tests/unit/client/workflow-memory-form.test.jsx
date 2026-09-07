import { describe, it, expect } from '@jest/globals';
import { usesProfilePath } from '../../../client/src/features/workflows/editor/panels/forms/MemoryForm.jsx';

describe('MemoryForm profile mode', () => {
  it('starts in path mode for a fresh node', () => {
    expect(usesProfilePath({})).toBe(true);
  });

  it('stays in fixed mode while the field is still empty', () => {
    // Choosing "a fixed agent profile" writes '', and the form must not flip
    // back before the user has typed anything.
    expect(usesProfilePath({ profileId: '' })).toBe(false);
  });

  it('stays in fixed mode once a profile is typed', () => {
    expect(usesProfilePath({ profileId: 'law-consultation-agent' })).toBe(false);
  });

  it('is in path mode when the workflow configures a path', () => {
    expect(usesProfilePath({ profileIdPath: 'agentProfileId' })).toBe(true);
  });

  it('tolerates a missing config', () => {
    expect(usesProfilePath(undefined)).toBe(true);
  });
});
