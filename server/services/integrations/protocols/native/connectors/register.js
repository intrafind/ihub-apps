// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Registers the built-in native connectors. Imported once at server start
 * (and by tests that need them); the connector registry itself imports no
 * connector, so the services the connectors use can import the registry.
 */
import { registerConnector } from './index.js';
import ifinder from './ifinder/index.js';
import iassistant from './iassistant.js';
import websearch from './websearch/index.js';
import jira from './jira/index.js';
import entra from './entra/index.js';
import ldapDirectory from './ldapDirectory/index.js';

registerConnector(ifinder);
registerConnector(iassistant);
registerConnector(websearch);
registerConnector(jira);
registerConnector(entra);
registerConnector(ldapDirectory);
