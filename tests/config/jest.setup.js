import dotenv from 'dotenv';
import path from 'path';
import { TextEncoder, TextDecoder } from 'node:util';
import v8 from 'node:v8';

// jest-environment-jsdom does not expose TextEncoder/TextDecoder as globals,
// but they are standard in every browser. Polyfill them so client code that
// decodes binary content (e.g. MSG/HTML byte streams) runs under jsdom.
if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;

// jsdom omits setImmediate; winston (used by the server logger) needs it, so
// any server module that logs would otherwise throw inside jsdom-based tests.
if (typeof globalThis.setImmediate === 'undefined') {
  globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
}
if (typeof globalThis.clearImmediate === 'undefined') {
  globalThis.clearImmediate = id => clearTimeout(id);
}

// jsdom omits structuredClone, which dagre uses during layout. A JSON
// round-trip is NOT a substitute — it drops undefined and Map/Set values and
// leaves dagre with a degenerate graph that lays every node on top of the
// next. v8's serializer gives real structured-clone semantics.
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
}

// Load test environment variables
dotenv.config({ path: path.resolve('.env.test') });
dotenv.config({ path: path.resolve('.env') });

// Set test-specific environment variables
process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';

// Mock external dependencies in test environment
global.console = {
  ...console,
  // Suppress logs in tests unless needed
  log: process.env.VERBOSE_TESTS ? console.log : jest.fn(),
  debug: process.env.VERBOSE_TESTS ? console.debug : jest.fn(),
  info: process.env.VERBOSE_TESTS ? console.info : jest.fn(),
  warn: console.warn,
  error: console.error
};

// Global test utilities
global.wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Setup test database or mock services here if needed
beforeAll(async () => {
  // Global setup
});

afterAll(async () => {
  // Global cleanup
});
