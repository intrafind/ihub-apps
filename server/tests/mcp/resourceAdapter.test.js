import { describe, it, expect } from '@jest/globals';
import { listMcpResources, readMcpResource } from '../../services/mcp/resourceAdapter.js';

describe('MCP resource adapter — URI parsing', () => {
  it('listMcpResources returns [] when expose.resources is false', () => {
    expect(listMcpResources({ user: {}, expose: { resources: false } })).toEqual([]);
  });

  it('listMcpResources returns an array when expose.resources is true', () => {
    const r = listMcpResources({ user: { permissions: {} }, expose: { resources: true } });
    expect(Array.isArray(r)).toBe(true);
  });

  it('rejects URIs with foreign schemes', async () => {
    await expect(readMcpResource('http://example.com/x', { user: {} })).rejects.toThrow(
      /Unsupported resource URI/
    );
  });

  it('rejects bare ihub:// without a path', async () => {
    await expect(readMcpResource('ihub://', { user: {} })).rejects.toThrow(/Malformed/);
  });

  it('rejects unknown resource kinds', async () => {
    await expect(readMcpResource('ihub://nonsense/x', { user: {} })).rejects.toThrow(
      /Unknown resource kind/
    );
  });

  it('rejects unknown source ids', async () => {
    await expect(readMcpResource('ihub://source/does-not-exist', { user: {} })).rejects.toThrow(
      /not found/
    );
  });

  it('rejects URL-encoded path-traversal in source ids', async () => {
    await expect(readMcpResource('ihub://source/..%2Fconfig', { user: {} })).rejects.toThrow(
      /Source not found/
    );
  });

  it('rejects URL-encoded path-traversal in skill names', async () => {
    await expect(readMcpResource('ihub://skill/..%2Fetc%2Fpasswd', { user: {} })).rejects.toThrow(
      /Skill not found/
    );
  });

  it('rejects skill names that fail the skillLoader name pattern', async () => {
    await expect(readMcpResource('ihub://skill/Bad Name', { user: {} })).rejects.toThrow(
      /Skill not found/
    );
  });
});
