// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import { listMcpResources, readMcpResource } from '../../services/mcp/resourceAdapter.js';

describe('MCP resource adapter — URI parsing', () => {
  it('listMcpResources returns [] when expose.resources is false', async () => {
    await expect(listMcpResources({ user: {}, expose: { resources: false } })).resolves.toEqual([]);
  });

  it('listMcpResources returns an array when expose.resources is true', async () => {
    const r = await listMcpResources({ user: { permissions: {} }, expose: { resources: true } });
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

  it('rejects unknown project ids', async () => {
    await expect(readMcpResource('ihub://project/does-not-exist', { user: {} })).rejects.toThrow(
      /not found/
    );
  });

  it('rejects URL-encoded path-traversal in project ids', async () => {
    // The path.basename sanitiser rejects the decoded `../config` before any
    // project lookup, so the failure surfaces as "Invalid resource id".
    await expect(readMcpResource('ihub://project/..%2Fconfig', { user: {} })).rejects.toThrow(
      /Invalid resource id/
    );
  });

  it('rejects URL-encoded path-traversal in skill names', async () => {
    await expect(readMcpResource('ihub://skill/..%2Fetc%2Fpasswd', { user: {} })).rejects.toThrow(
      /Invalid resource id/
    );
  });

  it('rejects skill names that fail the skillLoader name pattern', async () => {
    await expect(readMcpResource('ihub://skill/Bad Name', { user: {} })).rejects.toThrow(
      /Skill not found/
    );
  });
});

describe('MCP resource adapter — skill sub-resources', () => {
  it('rejects a path under an unknown skill', async () => {
    await expect(
      readMcpResource('ihub://skill/no-such-skill/references/guide.md', { user: {} })
    ).rejects.toThrow(/Skill not found/);
  });

  it('rejects a traversal path under a skill name', async () => {
    // The segments are decoded only after the split, so this stays a relative
    // path and is measured against the files the loader enumerated — it never
    // reaches the filesystem.
    await expect(
      readMcpResource('ihub://skill/ifinder-search/..%2F..%2Fetc%2Fpasswd', { user: {} })
    ).rejects.toThrow(/Skill (resource )?not found/);
  });

  it('rejects a path under a project', async () => {
    await expect(
      readMcpResource('ihub://project/some-project/secret.md', { user: {} })
    ).rejects.toThrow(/Project not found/);
  });
});
