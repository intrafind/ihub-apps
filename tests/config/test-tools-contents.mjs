// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The definition and the installation of the test tools `e2e_counter_write` and
 * `e2e_counter_read`, written into a contents directory of a test.
 *
 * iHub ships neither: an installation of iHub has no definition that names the
 * connector `ihub_test_tools`, and the connector itself is registered only in a
 * server started with `NODE_ENV=test` and `IHUB_TEST_TOOLS=1`
 * (`server/services/integrations/protocols/native/connectors/testTools.js`). A
 * server started without the two treats the installation written here as "not
 * implemented" and offers its tools to nobody.
 *
 * No side effects on import. `agents-server.mjs` and the fault harness
 * (`server/tests/faults/seed.mjs`) call it on their own contents directory.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The installation an app binds: `integrations: { 'e2e-counter': {} }`. */
export const TEST_TOOLS_INSTALLATION = 'e2e-counter';
/** The definition of the test tools. It lives only in a contents directory of a test. */
export const TEST_TOOLS_DEFINITION = 'test.ihub/e2e-counter';
/** The tool ids, as the model calls them (`e2e-tool:e2e_counter_write:{"key":"k"}`). */
export const COUNTER_WRITE = 'e2e_counter_write';
export const COUNTER_READ = 'e2e_counter_read';

const VERSION = '1.0.0';

const definition = () => ({
  id: TEST_TOOLS_DEFINITION,
  version: VERSION,
  compatibility: { ihub: '>=5.6.0' },
  name: { en: 'Test counter', de: 'Testzähler' },
  description: {
    en: 'A counter outside the server, for the fault tests and the browser suite. Test only.',
    de: 'Ein Zähler außerhalb des Servers, für die Fehlertests und die Browser-Suite. Nur für Tests.'
  },
  publisher: { name: 'iHub test suite' },
  // A fixed tool id needs a built-in definition; it still lives only in this directory.
  builtIn: true,
  categories: ['test'],
  protocol: { type: 'native', module: 'ihub_test_tools' },
  auth: { modes: ['none'] },
  install: [],
  capabilities: ['tools'],
  actions: [
    {
      name: COUNTER_WRITE,
      toolId: COUNTER_WRITE,
      title: { en: 'Count a write', de: 'Schreibvorgang zählen' },
      description: {
        en: 'Add one to the test counter of a key. Every call is a write.',
        de: 'Den Testzähler eines Schlüssels um eins erhöhen. Jeder Aufruf ist ein Schreibvorgang.'
      },
      sideEffect: 'write',
      dataFlow: 'external',
      connection: 'none'
    },
    {
      name: COUNTER_READ,
      toolId: COUNTER_READ,
      title: { en: 'Read the counter', de: 'Zähler lesen' },
      description: {
        en: 'Read the test counter of a key and the values written to it.',
        de: 'Den Testzähler eines Schlüssels und die dazu geschriebenen Werte lesen.'
      },
      sideEffect: 'read',
      dataFlow: 'external',
      connection: 'none'
    }
  ]
});

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Write the definition of the test tools into `integration-definitions/` and
 * their installation into `config/integrations.json`. Run it on a seeded
 * contents directory; calling it twice changes nothing.
 *
 * @param {string} contentsDir - Absolute path
 * @returns {void}
 */
export function seedTestTools(contentsDir) {
  const dir = path.join(
    contentsDir,
    'integration-definitions',
    TEST_TOOLS_DEFINITION.replace('/', '__')
  );
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'integration.json'), definition());

  const integrationsPath = path.join(contentsDir, 'config', 'integrations.json');
  const integrations = readJson(integrationsPath);
  integrations.installed = (integrations.installed || []).filter(
    installed => installed.id !== TEST_TOOLS_INSTALLATION
  );
  integrations.installed.push({
    id: TEST_TOOLS_INSTALLATION,
    definition: TEST_TOOLS_DEFINITION,
    definitionVersion: VERSION,
    enabled: true,
    values: {},
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} }
  });
  writeJson(integrationsPath, integrations);
}
