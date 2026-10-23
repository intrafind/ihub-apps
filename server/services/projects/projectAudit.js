// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Audit entries several project routes write alike.
 *
 * @module services/projects/projectAudit
 */
import { logAudit } from '../AuditLogService.js';
import { projectName } from './projectView.js';

/**
 * Audit a change of an admin project's published switch as a share:
 * publishing widens who may use the project to everyone signed in, as the
 * catalog does for a user project. Every route that can change the switch
 * calls this (the admin PUT and PATCH, and `PATCH /api/projects/:id`).
 *
 * @param {import('express').Request} req
 * @param {Object|null} before - The project before the change.
 * @param {Object} project - The project after it.
 */
export function auditPublished(req, before, project) {
  if (project?.ownership !== 'admin') return;
  if ((before?.published === true) === (project?.published === true)) return;
  logAudit({
    req,
    action: 'share',
    resource: 'projectShare',
    resourceId: project.id,
    summary: `${project.published ? 'Published' : 'Unpublished'} admin project "${projectName(project)}"`
  });
}
