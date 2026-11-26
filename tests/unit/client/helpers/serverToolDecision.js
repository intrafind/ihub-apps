// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A `tool/started` frame as the server sends it: the row kind and scope come
 * from the server's own decision (server/utils/toolDisplay.js), so fixtures
 * never teach the client to infer them from a tool id.
 */
import { toolDisplayOf } from '../../../../server/utils/toolDisplay.js';

const WEB = { kind: 'search', origin: 'web' };

/**
 * What the built-in tools declare (`activity`; the server's own tests check the
 * real definitions). A tool id that is not here declares nothing: the server
 * sends a plain call, whatever the id says.
 */
const DECLARED = {
  braveSearch: WEB,
  staanSearch: WEB,
  read_url: { kind: 'fetch', origin: 'web' },
  knowledge_search: { kind: 'search', origin: 'project' },
  knowledge_list: { kind: 'search', origin: 'project' },
  knowledge_read: { kind: 'fetch', origin: 'project' },
  iFinder_search: { kind: 'search', origin: 'ifinder' },
  iFinder_getContent: { kind: 'fetch', origin: 'ifinder' }
};

export function withServerDecision(type, data = {}) {
  if (type !== 'tool/started' || !data.toolId || data.activityKind) return data;
  const { activityKind, activityOrigin } = toolDisplayOf({
    id: data.toolId,
    ...(DECLARED[data.toolId] ? { activity: DECLARED[data.toolId] } : {})
  });
  return {
    ...data,
    activityKind,
    ...(activityOrigin ? { activityOrigin } : {})
  };
}
