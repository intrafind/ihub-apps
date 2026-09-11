/**
 * StorageRegistry specs — how the process picks its storage backend.
 *
 * The registry is the one piece of the storage layer with process-wide state
 * (the singleton provider), so every case here shuts it down again in an
 * `afterEach`: a test that leaked an initialized provider would silently
 * invalidate the "before initialization" and "double init" cases that follow.
 *
 * Resolution is exercised through a stub provider rather than the filesystem
 * one, so nothing here touches disk. The registry duck-types what a factory
 * returns, which is exactly what makes that stub possible.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProvider,
  DEFAULT_CAPABILITIES,
  getRegisteredProviders,
  getStorageProvider,
  hasProvider,
  initializeStorage,
  registerProvider,
  resolveStorageConfig,
  shutdownStorage,
  StorageError,
  UnknownProviderError
} from '../storage/index.js';

/** Registered under a test-only name so the real providers stay untouched. */
const STUB = 'registry-test-stub';

/** Minimal provider: records how often the registry drove its lifecycle. */
class StubProvider {
  constructor(config) {
    this.config = config;
    this.initializeCount = 0;
    this.shutdownCount = 0;
  }

  get name() {
    return STUB;
  }

  async initialize() {
    this.initializeCount += 1;
  }

  async shutdown() {
    this.shutdownCount += 1;
  }
}

registerProvider(STUB, config => new StubProvider(config));

/** Registered under its own name so the failing case cannot affect the others. */
const BROKEN = 'registry-test-broken';

/** A provider whose backend is down: `initialize()` rejects after opening. */
class BrokenProvider extends StubProvider {
  get name() {
    return BROKEN;
  }

  async initialize() {
    this.initializeCount += 1;
    throw new StorageError('backend unreachable', { code: 'INIT_FAILED' });
  }
}

/** The last one built, so a test can inspect a provider the registry threw away. */
let lastBroken = null;
registerProvider(BROKEN, config => {
  lastBroken = new BrokenProvider(config);
  return lastBroken;
});

/** Platform config naming the stub, optionally with a config block. */
function stubPlatform(config) {
  return { storage: { provider: STUB, ...(config ? { [STUB]: config } : {}) } };
}

afterEach(async () => {
  await shutdownStorage();
});

describe('resolveStorageConfig', () => {
  it('lets IHUB_STORAGE_PROVIDER override platform.json', () => {
    const resolved = resolveStorageConfig(
      { storage: { provider: 'filesystem', sqlite: { file: 'ihub.db' } } },
      { IHUB_STORAGE_PROVIDER: 'sqlite' }
    );
    assert.equal(resolved.provider, 'sqlite');
    assert.deepEqual(resolved.config, { file: 'ihub.db' });
  });

  it('lets platform.json override the default', () => {
    const resolved = resolveStorageConfig({ storage: { provider: 'sqlite' } }, {});
    assert.equal(resolved.provider, 'sqlite');
  });

  it('falls back to filesystem when nothing names a provider', () => {
    assert.deepEqual(resolveStorageConfig({}, {}), { provider: 'filesystem', config: {} });
    assert.deepEqual(resolveStorageConfig(undefined, {}), { provider: 'filesystem', config: {} });
    assert.equal(resolveStorageConfig({ storage: {} }, {}).provider, 'filesystem');
  });

  it('ignores a blank environment override', () => {
    const resolved = resolveStorageConfig(
      { storage: { provider: 'sqlite' } },
      { IHUB_STORAGE_PROVIDER: '   ' }
    );
    assert.equal(resolved.provider, 'sqlite');
  });

  it('returns the block belonging to the resolved provider', () => {
    const resolved = resolveStorageConfig(
      {
        storage: {
          provider: 'filesystem',
          filesystem: { dataDir: 'data', flushIntervalMs: 2000 },
          sqlite: { file: 'ignored.db' }
        }
      },
      {}
    );
    assert.deepEqual(resolved.config, { dataDir: 'data', flushIntervalMs: 2000 });
  });

  it('returns an empty object for a provider with no config block', () => {
    const resolved = resolveStorageConfig({ storage: { provider: 'opensearch' } }, {});
    assert.deepEqual(resolved.config, {});
    // Callers spread and mutate this; it must never be a shared or inherited object.
    assert.equal(Object.keys(resolved.config).length, 0);
  });
});

describe('the capability baseline', () => {
  it('declares every capability a caller branches on, including rawNamespaces', () => {
    // The baseline is what a provider that overrides nothing reports, and
    // "everything off, no reach" only holds if every key is present. An absent
    // key reads as `undefined`, which is neither on nor off: `ConfigStore`
    // asks for `rawNamespaces` and would see a provider serving no raw
    // configuration and one that forgot to mention it as the same thing — the
    // first a supported deployment, the second a bug.
    for (const key of [
      'notifications',
      'locking',
      'multiInstance',
      'blobs',
      'conditionalWrites',
      'rawNamespaces'
    ]) {
      assert.ok(
        Object.hasOwn(DEFAULT_CAPABILITIES, key),
        `DEFAULT_CAPABILITIES is missing ${key}, so a provider inheriting it reports undefined`
      );
    }
    assert.deepEqual(DEFAULT_CAPABILITIES.rawNamespaces, [], 'and the baseline serves none');
  });
});

describe('provider registration', () => {
  it('registers the filesystem provider when storage/index.js is imported', () => {
    assert.equal(hasProvider('filesystem'), true);
    assert.ok(getRegisteredProviders().includes('filesystem'));
  });

  it('lists registered providers sorted', () => {
    const names = getRegisteredProviders();
    assert.deepEqual(names, [...names].sort());
    assert.equal(hasProvider('definitely-not-registered'), false);
  });

  it('builds a provider from its factory and passes the config through', () => {
    const provider = createProvider(STUB, { marker: 'yes' });
    assert.ok(provider instanceof StubProvider);
    assert.deepEqual(provider.config, { marker: 'yes' });
    assert.equal(provider.initializeCount, 0, 'the factory must not do I/O');
  });

  it('throws UnknownProviderError naming the registered providers', () => {
    assert.throws(
      () => createProvider('does-not-exist'),
      error => {
        assert.ok(error instanceof UnknownProviderError);
        assert.equal(error.code, 'UNKNOWN_PROVIDER');
        assert.match(error.message, /does-not-exist/);
        assert.match(error.message, /filesystem/, 'the message lists what is registered');
        return true;
      }
    );
  });

  it('replaces the factory when a name is registered again', () => {
    const name = 'registry-test-replaceable';
    registerProvider(name, () => ({ name, generation: 'first' }));
    registerProvider(name, () => ({ name, generation: 'second' }));
    assert.equal(createProvider(name).generation, 'second');
  });
});

describe('the storage singleton', () => {
  it('throws STORAGE_NOT_INITIALIZED before initializeStorage runs', () => {
    assert.throws(
      () => getStorageProvider(),
      error => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, 'STORAGE_NOT_INITIALIZED');
        return true;
      }
    );
  });

  it('round-trips initialize -> get -> shutdown', async () => {
    const provider = await initializeStorage({
      platformConfig: stubPlatform({ marker: 'configured' }),
      env: {}
    });
    assert.ok(provider instanceof StubProvider);
    assert.deepEqual(provider.config, { marker: 'configured' });
    assert.equal(provider.initializeCount, 1);
    assert.equal(getStorageProvider(), provider);

    await shutdownStorage();
    assert.equal(provider.shutdownCount, 1);
    assert.throws(() => getStorageProvider(), /not initialized/);
  });

  it('honours the environment override when initializing', async () => {
    const provider = await initializeStorage({
      platformConfig: { storage: { provider: 'filesystem' } },
      env: { IHUB_STORAGE_PROVIDER: STUB }
    });
    assert.equal(provider.name, STUB);
  });

  it('returns the running instance when initialized twice', async () => {
    const first = await initializeStorage({ platformConfig: stubPlatform(), env: {} });
    // A different provider name is deliberate: swapping backends needs a
    // restart, so the second call must hand back the running one untouched.
    const second = await initializeStorage({
      platformConfig: { storage: { provider: 'filesystem' } },
      env: {}
    });
    assert.equal(second, first);
    assert.equal(first.initializeCount, 1);
  });

  it('shares one instance between concurrent initializations', async () => {
    const [first, second] = await Promise.all([
      initializeStorage({ platformConfig: stubPlatform(), env: {} }),
      initializeStorage({ platformConfig: stubPlatform(), env: {} })
    ]);
    assert.equal(second, first);
    assert.equal(first.initializeCount, 1);
  });

  it('leaves nothing initialized when the configured provider is unknown', async () => {
    await assert.rejects(
      () =>
        initializeStorage({
          platformConfig: { storage: { provider: 'does-not-exist' } },
          env: {}
        }),
      UnknownProviderError
    );
    assert.throws(() => getStorageProvider(), /not initialized/);
  });

  it('shuts down a provider whose initialize() rejected', async () => {
    // The filesystem provider owns nothing worth reclaiming, but the contract
    // tells implementers to open pools and connections in `initialize()` — and
    // a backend that is down is exactly when the server ends up in a restart
    // loop, so a leak per attempt compounds. The provider is discarded either
    // way; the question is whether it is given the chance to close what it
    // opened first.
    lastBroken = null;
    await assert.rejects(
      () =>
        initializeStorage({
          platformConfig: { storage: { provider: BROKEN } },
          env: {}
        }),
      error => error?.code === 'INIT_FAILED',
      'the original failure is what the caller needs, not a shutdown error on top of it'
    );
    assert.ok(lastBroken, 'the factory ran');
    assert.equal(lastBroken.shutdownCount, 1, 'and the half-built provider was shut down');
    assert.throws(() => getStorageProvider(), /not initialized/, 'nothing was published');
  });

  it('shuts down idempotently, including when nothing is initialized', async () => {
    await shutdownStorage();
    const provider = await initializeStorage({ platformConfig: stubPlatform(), env: {} });
    await shutdownStorage();
    await shutdownStorage();
    assert.equal(provider.shutdownCount, 1, 'the provider is shut down exactly once');
  });
});
