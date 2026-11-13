// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A `tool/started` frame as the server sends it: the row kind and scope come
 * from the server's own decision (server/utils/toolDisplay.js), so fixtures
 * never teach the client to infer them from a tool id.
 */
import {
  activityKindOf,
  activityOriginOfSource,
  activityScopeOf
} from '../../../../server/utils/toolDisplay.js';
import { classifyKnowledgeSource } from '../../../../server/services/loop/seams/knowledgeSourceSeam.js';

export function withServerDecision(type, data = {}) {
  if (type !== 'tool/started' || !data.toolId || data.activityKind) return data;
  const source = classifyKnowledgeSource(data.toolId);
  const activityKind = activityKindOf(data.toolId, source);
  const activityOrigin = activityOriginOfSource(source);
  return {
    ...data,
    activityKind,
    ...(activityKind === 'tool' ? {} : { activityScope: activityScopeOf(data.toolId, source) }),
    ...(activityOrigin ? { activityOrigin } : {})
  };
}
