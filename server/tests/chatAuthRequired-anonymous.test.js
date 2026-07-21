import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import configCache from '../configCache.js';
import { chatAuthRequired } from '../middleware/authRequired.js';

// Regression test for #1688: anonymous requests were reaching chat endpoints
// for ANY app id because req.user was never materialized for tokenless
// requests, so appAccessRequired's permission check silently no-op'd.
//
// loadGroupsConfiguration() (server/utils/authorization.js) reads
// contents/config/groups.json straight off disk with no injection point, so
// this test writes a temporary fixture there and restores whatever was
// present before (or removes the file/directory it created) afterwards.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const groupsConfigPath = path.join(__dirname, '../../contents/config/groups.json');
const groupsConfigDir = path.dirname(groupsConfigPath);
const contentsDir = path.join(__dirname, '../../contents');

const fixtureGroups = {
  groups: {
    anonymous: {
      id: 'anonymous',
      permissions: { apps: ['public-app'], prompts: ['*'], models: ['*'], adminAccess: false }
    }
  }
};

let preexistingGroupsConfig;
let createdGroupsConfigDir = false;
let createdContentsDir = false;

const originalGetPlatform = configCache.getPlatform.bind(configCache);

function mockPlatform({ anonymousEnabled }) {
  configCache.getPlatform = () => ({
    anonymousAuth: { enabled: anonymousEnabled, defaultGroups: ['anonymous'] },
    auth: {}
  });
}

function makeReqRes(appId) {
  const req = {
    user: undefined,
    params: { appId },
    url: `/api/apps/${appId}/chat/x`,
    method: 'POST',
    headers: {}
  };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  return { req, res };
}

describe('chatAuthRequired anonymous app-permission enforcement', () => {
  before(() => {
    if (!fs.existsSync(contentsDir)) {
      createdContentsDir = true;
    } else if (!fs.existsSync(groupsConfigDir)) {
      createdGroupsConfigDir = true;
    }
    fs.mkdirSync(groupsConfigDir, { recursive: true });
    if (fs.existsSync(groupsConfigPath)) {
      preexistingGroupsConfig = fs.readFileSync(groupsConfigPath, 'utf8');
    }
    fs.writeFileSync(groupsConfigPath, JSON.stringify(fixtureGroups, null, 2));
  });

  after(() => {
    if (preexistingGroupsConfig !== undefined) {
      fs.writeFileSync(groupsConfigPath, preexistingGroupsConfig);
    } else if (createdContentsDir) {
      fs.rmSync(contentsDir, { recursive: true, force: true });
    } else if (createdGroupsConfigDir) {
      fs.rmSync(groupsConfigDir, { recursive: true, force: true });
    } else {
      fs.rmSync(groupsConfigPath, { force: true });
    }
  });

  afterEach(() => {
    configCache.getPlatform = originalGetPlatform;
  });

  it('blocks anonymous access to an app not allowlisted for the anonymous group', () => {
    mockPlatform({ anonymousEnabled: true });
    const { req, res } = makeReqRes('non-allowlisted-app');
    let calledNext = false;

    chatAuthRequired(req, res, () => {
      calledNext = true;
    });

    assert.strictEqual(calledNext, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'APP_ACCESS_DENIED');
    assert.strictEqual(req.user?.id, 'anonymous');
  });

  it('allows anonymous access to an app allowlisted for the anonymous group', () => {
    mockPlatform({ anonymousEnabled: true });
    const { req, res } = makeReqRes('public-app');
    let calledNext = false;

    chatAuthRequired(req, res, () => {
      calledNext = true;
    });

    assert.strictEqual(calledNext, true);
    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(req.user?.id, 'anonymous');
  });

  it('rejects unauthenticated requests outright when anonymous access is disabled', () => {
    mockPlatform({ anonymousEnabled: false });
    const { req, res } = makeReqRes('public-app');
    let calledNext = false;

    chatAuthRequired(req, res, () => {
      calledNext = true;
    });

    assert.strictEqual(calledNext, false);
    assert.strictEqual(res.statusCode, 401);
  });
});
