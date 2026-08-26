import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { workflowConfigSchema } from '../../../../server/validators/workflowConfigSchema.js';

const WORKFLOW_DIR = path.resolve(process.cwd(), 'server/defaults/workflows');
const files = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.json'));
const load = f => JSON.parse(fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf-8'));

describe('shipped default workflows', () => {
  it.each(files)('%s satisfies the workflow schema', file => {
    const result = workflowConfigSchema.safeParse(load(file));
    const problems = result.success
      ? []
      : result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
    expect(problems).toEqual([]);
  });

  it.each(files)('%s keeps every container child inside a real container', file => {
    const wf = load(file);
    const containers = new Set(wf.nodes.filter(n => n.type === 'loop').map(n => n.id));
    const orphans = wf.nodes
      .filter(n => n.parentId && !containers.has(n.parentId))
      .map(n => `${n.id} -> ${n.parentId}`);
    expect(orphans).toEqual([]);
  });
});

describe('loop bookkeeping options', () => {
  const withLoops = files.filter(f => load(f).nodes.some(n => n.type === 'loop'));

  it.each(withLoops)('%s names its forEach items instead of leaning on _loopItem', file => {
    const wf = load(file);
    // A forEach container whose body is itself a container must name its item,
    // otherwise the inner loop shadows _loopItem for every step after it.
    const shadowed = wf.nodes
      .filter(n => n.type === 'loop' && (n.config?.mode || 'forEach') === 'forEach')
      .filter(n => wf.nodes.some(c => c.parentId === n.id && c.type === 'loop'))
      .filter(n => !n.config?.itemVariable)
      .map(n => n.id);
    expect(shadowed).toEqual([]);
  });

  it.each(withLoops)('%s has no counting step left inside a loop body', file => {
    const wf = load(file);
    const containers = new Set(wf.nodes.filter(n => n.type === 'loop').map(n => n.id));
    const counters = wf.nodes
      .filter(n => containers.has(n.parentId) && n.type === 'transform')
      .filter(n => {
        const ops = n.config?.operations || [];
        // A body step whose *only* work is bumping a counter is what `countInto`
        // replaces; a transform that also moves data is still real work.
        return ops.length > 0 && ops.every(op => op.increment !== undefined);
      })
      .map(n => n.id);
    expect(counters).toEqual([]);
  });
});

describe('progress notes', () => {
  it('are objects on ordinary steps and strings only on progress nodes', () => {
    const offenders = [];
    for (const file of files) {
      for (const node of load(file).nodes) {
        const progress = node.config?.progress;
        if (progress === undefined) continue;
        if (node.type === 'progress') continue;
        if (typeof progress !== 'object' || Array.isArray(progress) || !progress.message) {
          offenders.push(`${file}:${node.id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reference only variables their loop actually provides', () => {
    const offenders = [];
    for (const file of files) {
      const wf = load(file);
      const byId = new Map(wf.nodes.map(n => [n.id, n]));
      for (const node of wf.nodes) {
        const message = node.config?.progress?.message;
        if (typeof message !== 'string') continue;
        // Collect the item names in scope: this node's ancestors' itemVariables.
        const inScope = new Set(['_loopItem', '_loopIndex', '_loopHuman', '_loopTotal']);
        let cursor = byId.get(node.parentId);
        while (cursor) {
          if (cursor.config?.itemVariable) inScope.add(cursor.config.itemVariable);
          cursor = byId.get(cursor.parentId);
        }
        for (const [, name] of message.matchAll(/\{\{\s*(_[A-Za-z_$][\w$]*)/g)) {
          if (!inScope.has(name)) offenders.push(`${file}:${node.id} -> {{${name}}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
