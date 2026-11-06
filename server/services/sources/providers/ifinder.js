// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `ifinder` source provider: the `files` capability of the iFinder
 * integration, for the callers that act on a source by its `provider` and
 * `ref` (the answer sources panel, project link items). It holds no logic of
 * its own; the integration's routes (`routes/integrations/files.js`) and this
 * provider run the same code.
 *
 * @module services/sources/providers/ifinder
 */
import files from '../../integrations/protocols/native/connectors/ifinder/files.js';

// `integration` names the installation whose gate (configured, granted) applies to
// requests that reach this provider over HTTP; see `resolveDocumentProvider`.
export default {
  id: 'ifinder',
  integration: 'ifinder',
  content: files.content,
  metadata: files.metadata
};
