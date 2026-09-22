import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { getJsonSchemaByType } from '../../../server/utils/schemaExport.js';
import { groupConfigSchema } from '../../../server/validators/groupConfigSchema.js';
import { validateWithSchema } from '../../../client/src/utils/schemaValidation.js';

/**
 * The admin editors (Monaco + DualModeEditor) validate what an admin is editing
 * against the JSON Schema `/api/admin/schemas/:type` exports from the Zod
 * schemas. A config the platform itself ships must therefore pass — otherwise
 * merely OPENING it reports errors, as `z.toJSONSchema`'s default output mode
 * did: it marks every `.prefault()` field required and closes plain objects to
 * additional properties, so a group read straight off disk failed with
 * "enabled is required" and "must NOT have additional properties".
 */

const repoRoot = process.cwd();

function describeErrors(errors) {
  return errors.map(error => `${error.field}: ${error.message}`).join(', ');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readConfigDir(directory) {
  const directoryPath = path.join(repoRoot, directory);
  return fs
    .readdirSync(directoryPath)
    .filter(fileName => fileName.endsWith('.json'))
    .map(fileName => ({ fileName, config: readJson(path.join(directoryPath, fileName)) }));
}

describe('admin editor JSON schemas', () => {
  it.each([
    ['apps', 'app', 'server/defaults/apps'],
    ['models', 'model', 'server/defaults/models'],
    ['prompts', 'prompt', 'server/defaults/prompts']
  ])('accepts every shipped %s config', (_label, type, directory) => {
    const schema = getJsonSchemaByType(type);
    const rejected = readConfigDir(directory)
      .map(({ fileName, config }) => ({ fileName, result: validateWithSchema(config, schema) }))
      .filter(({ result }) => !result.isValid)
      .map(({ fileName, result }) => `${fileName} (${describeErrors(result.errors)})`);

    expect(rejected).toEqual([]);
  });

  it('accepts the shipped platform config', () => {
    const platform = readJson(path.join(repoRoot, 'server/defaults/config/platform.json'));
    const result = validateWithSchema(platform, getJsonSchemaByType('platform'));

    expect(describeErrors(result.errors)).toBe('');
    expect(result.isValid).toBe(true);
  });

  it('accepts every shipped group', () => {
    const schema = getJsonSchemaByType('group');
    const { groups } = readJson(path.join(repoRoot, 'server/defaults/config/groups.json'));
    const rejected = Object.entries(groups)
      .map(([groupId, group]) => ({ groupId, result: validateWithSchema(group, schema) }))
      .filter(({ result }) => !result.isValid)
      .map(({ groupId, result }) => `${groupId} (${describeErrors(result.errors)})`);

    expect(rejected).toEqual([]);
  });

  it('accepts a group in the shape the admin save handler writes', () => {
    // normalizeGroupPermissions (routes/admin/groups.js) writes every one of
    // these keys, `contentAdmin` included, and never adds `enabled`.
    const saved = {
      id: 'mcp-power-users',
      name: 'MCP Power Users',
      description: 'Direct tool access over the gateways',
      permissions: {
        apps: [],
        prompts: ['*'],
        models: ['*'],
        workflows: [],
        skills: ['*'],
        tools: ['iFinder'],
        adminAccess: false,
        contentAdmin: true
      },
      mappings: []
    };
    const result = validateWithSchema(saved, getJsonSchemaByType('group'));

    expect(describeErrors(result.errors)).toBe('');
    expect(result.isValid).toBe(true);
  });

  it('describes every permission the authorization layer reads', () => {
    // A permission added to authorization.js but not here makes the group
    // editor reject any group that uses it as an unknown property.
    const authorization = fs.readFileSync(
      path.join(repoRoot, 'server/utils/authorization.js'),
      'utf8'
    );
    const seeded = [
      ...[...authorization.matchAll(/^\s{4}(\w+): new Set\(\),?$/gm)].map(match => match[1]),
      ...[...authorization.matchAll(/^\s{4}(\w+): false,?$/gm)].map(match => match[1])
    ];

    expect(seeded.length).toBeGreaterThan(0);
    expect(Object.keys(groupConfigSchema.shape.permissions.def.innerType.shape).sort()).toEqual(
      [...new Set(seeded)].sort()
    );
  });
});
