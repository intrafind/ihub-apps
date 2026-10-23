// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, expect, it, jest, beforeEach } from '@jest/globals';

/**
 * Publishing an admin project widens who may use it to everyone signed in,
 * so a change of the switch is audited as a share, from whichever route
 * made it.
 */
const mockLogAudit = jest.fn();
jest.mock('../../../server/services/AuditLogService.js', () => ({
  logAudit: (...args) => mockLogAudit(...args)
}));

const { auditPublished } = require('../../../server/services/projects/projectAudit.js');

const req = { user: { id: 'u_admin' } };
const project = (published, ownership = 'admin') => ({
  id: 'faq',
  ownership,
  name: { en: 'FAQ' },
  ...(published === undefined ? {} : { published })
});

describe('auditPublished', () => {
  beforeEach(() => mockLogAudit.mockReset());

  it('logs publishing and unpublishing as a share', () => {
    auditPublished(req, project(undefined), project(true));
    expect(mockLogAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'share',
        resource: 'projectShare',
        resourceId: 'faq',
        summary: 'Published admin project "FAQ"'
      })
    );
    auditPublished(req, project(true), project(false));
    expect(mockLogAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ summary: 'Unpublished admin project "FAQ"' })
    );
  });

  it('logs nothing when the switch did not change, or for a user project', () => {
    auditPublished(req, project(true), project(true));
    auditPublished(req, project(undefined), project(false));
    auditPublished(req, project(undefined, 'user'), project(true, 'user'));
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
