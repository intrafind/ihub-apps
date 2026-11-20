// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test-only tools for the fault tests and the browser suite of the agents work
 * (`server/tests/faults/`, `tests/e2e-agents/`, docs/run-testing.md).
 *
 * A test of "this write ran exactly once" needs a write whose effect lives
 * outside the server: a server that is killed takes everything inside it along.
 * The two tools of this connector talk to a counter that the test process
 * hosts (`tests/config/test-counter.mjs`):
 *
 * - `e2e_counter_write` adds one to the counter of a key. It is a write: it
 *   is not read-only and never runs side by side with another call.
 * - `e2e_counter_read` returns the count and the values written for a key. It
 *   is a read, and what it returns is content from outside iHub
 *   (`untrustedInput`): the offline stand-in for a page or a document, because
 *   a page reader that fetches from the test machine is stopped by the SSRF
 *   guard.
 *
 * The connector is registered only when **both** of these hold when this
 * module is imported (`register.js`): `NODE_ENV` is `test` and
 * `IHUB_TEST_TOOLS` is `1`. In every installation it is not registered, so the
 * tools do not exist: an action of a connector that is not registered is "not
 * implemented" and is offered to nobody. The definition and the installation
 * of the tools are written by the test into its own contents directory
 * (`tests/config/test-tools-contents.mjs`); iHub ships neither.
 *
 * `IHUB_TEST_COUNTER_URL` is the address of the counter. It is read once, at
 * import.
 *
 * @module services/integrations/protocols/native/connectors/testTools
 */
import { httpFetch } from '../../../../../utils/httpConfig.js';
import { killPoint as processKillPoint } from '../../../../../utils/killPoint.js';

/** The `protocol.module` a definition names to get these tools. */
export const TEST_TOOLS_CONNECTOR_ID = 'ihub_test_tools';

/** The tool ids, which are also the names of the actions. */
export const TEST_TOOL_IDS = Object.freeze(['e2e_counter_write', 'e2e_counter_read']);

/** A counter key: what a test may put into a URL path without escaping surprises. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Whether the test tools are switched on in an environment.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function testToolsArmed(env = process.env) {
  return env.NODE_ENV === 'test' && env.IHUB_TEST_TOOLS === '1';
}

/** Read once: a value set in a running server switches nothing on. */
export const TEST_TOOLS_ARMED = testToolsArmed();

const keyParameter = {
  type: 'string',
  description: {
    en: 'The name of the counter: letters, digits, dot, underscore and hyphen.',
    de: 'Der Name des Zählers: Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich.'
  }
};

function keyOf(args) {
  const key = args?.key;
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw new Error('key must be 1 to 64 letters, digits, dots, underscores or hyphens');
  }
  return key;
}

/**
 * Build the connector. The server uses the one built from its environment
 * ({@link testToolsConnector}); the parameters exist for the unit test.
 *
 * @param {Object} [options]
 * @param {string} [options.counterUrl] - Base address of the counter
 * @param {typeof httpFetch} [options.fetch]
 * @param {(name: string) => void} [options.killPoint]
 * @returns {Object} A native connector (see `connectors/index.js`)
 */
export function createTestToolsConnector({
  counterUrl = process.env.IHUB_TEST_COUNTER_URL || '',
  fetch = httpFetch,
  killPoint = processKillPoint
} = {}) {
  const endpoint = key => {
    if (!counterUrl) {
      throw new Error('IHUB_TEST_COUNTER_URL is not set: the test tools have no counter to reach');
    }
    return `${counterUrl.replace(/\/+$/, '')}/count/${encodeURIComponent(key)}`;
  };

  const call = async (key, init) => {
    const response = await fetch(endpoint(key), init);
    if (!response.ok) throw new Error(`The test counter answered ${response.status}`);
    return response.json();
  };

  return {
    id: TEST_TOOLS_CONNECTOR_ID,
    actions: {
      e2e_counter_write: {
        parameters: {
          type: 'object',
          properties: {
            key: keyParameter,
            value: {
              type: 'string',
              description: {
                en: 'A text to store with this write. Optional.',
                de: 'Ein Text, der mit diesem Schreibvorgang gespeichert wird. Optional.'
              }
            }
          },
          required: ['key']
        },
        async run(args) {
          const key = keyOf(args);
          const value = typeof args.value === 'string' ? args.value : undefined;
          // The call has started and nothing was written yet.
          killPoint('e2e-counter-before-write');
          const result = await call(key, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value })
          });
          // The write happened and its result is not stored anywhere in iHub yet.
          killPoint('e2e-counter-after-write');
          return { key, count: result.count };
        }
      },
      e2e_counter_read: {
        parameters: {
          type: 'object',
          properties: { key: keyParameter },
          required: ['key']
        },
        // What the counter holds was written by somebody else: outside content.
        extras: () => ({ untrustedInput: true }),
        async run(args) {
          const key = keyOf(args);
          const result = await call(key, { method: 'GET' });
          return { key, count: result.count, values: result.values };
        }
      }
    },
    async test() {
      return [
        {
          id: 'counter',
          label: 'Test counter',
          status: counterUrl ? 'ok' : 'fail',
          message: counterUrl || 'IHUB_TEST_COUNTER_URL is not set'
        }
      ];
    },
    status() {
      return { connected: Boolean(counterUrl), toolCount: TEST_TOOL_IDS.length };
    },
    invalidate() {},
    onChanged() {}
  };
}

/**
 * Register the test tools when they are switched on, and say so in one line.
 *
 * @param {(connector: Object) => void} register - `registerConnector`
 * @param {Object} [options]
 * @param {boolean} [options.armed=TEST_TOOLS_ARMED]
 * @param {(message: string, meta: Object) => void} [options.warn]
 * @returns {boolean} Whether the connector was registered
 */
export function registerTestTools(register, { armed = TEST_TOOLS_ARMED, warn = () => {} } = {}) {
  if (!armed) return false;
  register(createTestToolsConnector());
  warn(
    'TEST ONLY: the test tools e2e_counter_write and e2e_counter_read are registered ' +
      '(NODE_ENV=test and IHUB_TEST_TOOLS=1). Never set IHUB_TEST_TOOLS in an installation.',
    { component: 'TestTools', tools: TEST_TOOL_IDS }
  );
  return true;
}
