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

registerConnector(ifinder);
registerConnector(iassistant);
