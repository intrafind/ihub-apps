import { describe, it, expect } from '@jest/globals';
import { nodeConfigSchema } from '../../../../server/validators/workflowConfigSchema.js';

const baseNode = {
  id: 'refine-decision',
  type: 'prompt',
  name: { en: 'Decide' },
  position: { x: 0, y: 0 }
};

describe('nodeConfigSchema — per-node thinking', () => {
  it('accepts a valid thinking override (enabled + level)', () => {
    const r = nodeConfigSchema.safeParse({
      ...baseNode,
      config: { thinking: { enabled: false, level: 'low' } }
    });
    expect(r.success).toBe(true);
  });

  it('accepts the Gemini 2.5 budget shape', () => {
    const r = nodeConfigSchema.safeParse({
      ...baseNode,
      config: { thinking: { enabled: true, budget: 512, thoughts: false } }
    });
    expect(r.success).toBe(true);
  });

  it('accepts a node with no thinking block at all', () => {
    const r = nodeConfigSchema.safeParse({ ...baseNode, config: { chatVisible: false } });
    expect(r.success).toBe(true);
  });

  it('rejects a thinking block with an unknown/typo key', () => {
    const r = nodeConfigSchema.safeParse({
      ...baseNode,
      config: { thinking: { enabld: true } }
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-boolean enabled', () => {
    const r = nodeConfigSchema.safeParse({
      ...baseNode,
      config: { thinking: { enabled: 'yes' } }
    });
    expect(r.success).toBe(false);
  });
});
