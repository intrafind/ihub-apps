// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The handlers of `/api/projects` for the iFinder tier (iteration 2 of #3024):
 * create a smart collection, rename it, add iFinder documents and remove them.
 *
 * They are the branch the three allow-listed write routes take for an `ifc_` id
 * (`IFINDER_WRITE_ROUTES` in `middleware/projectAccess.js`); every other route
 * still refuses such an id. The work is the writer's
 * (`services/projects/ifinder/IFinderCollectionWriter.js`): here the request is
 * checked, the answer shaped and the change audited.
 *
 * @module routes/projectIFinderHandlers
 */
import { callerContext } from '../middleware/projectAccess.js';
import { logAudit } from '../services/AuditLogService.js';
import { collectionIdOf, isIFinderProjectId } from '../services/projects/projectConstants.js';
import { ProjectError } from '../services/projects/projectErrors.js';
import { itemIdOf } from '../services/projects/ifinder/IFinderTier.js';
import {
  addDocuments,
  createCollection,
  removeDocuments,
  renameCollection
} from '../services/projects/ifinder/IFinderCollectionWriter.js';
import { projectName, serializeItem } from '../services/projects/projectView.js';
import {
  addItemSchema,
  describeIssues,
  ifinderAddItemsSchema,
  ifinderProjectUpdateSchema
} from '../validators/projectSchema.js';
import { sendBadRequest } from '../utils/responseHelpers.js';
import { isMultipart, sendProjectError } from './projectItemRoutes.js';

/**
 * Run `handler` for a smart collection and hand everything else on: a middleware
 * for the allow-listed routes, placed right after their access gate.
 *
 * @param {(req: Object, res: Object) => Promise<void>} handler
 * @returns {import('express').RequestHandler}
 */
export function forIFinderProject(handler) {
  return (req, res, next) => (isIFinderProjectId(req.project?.id) ? handler(req, res) : next());
}

function parse(schema, req, res) {
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    sendBadRequest(res, `Invalid request: ${describeIssues(parsed.error)}`);
    return null;
  }
  return parsed.data;
}

/**
 * `POST /api/projects` with `tier: 'ifinder'`: create a smart collection. The
 * caller has passed the user-project gate; the body is already validated.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {{body: Object, serialize: (project: Object, user: Object, context: Object) => Object}} options
 */
export async function createIFinderProject(req, res, { body, serialize }) {
  try {
    if (body.instructions !== undefined || body.defaultAppId !== undefined) {
      return sendBadRequest(
        res,
        'A smart collection has a name and a description. Instructions and a default app do not apply to it'
      );
    }
    const project = await createCollection(req.user, {
      name: body.name,
      description: body.description || ''
    });
    logAudit({
      req,
      action: 'create',
      resource: 'project',
      resourceId: project.id,
      summary: `Created iFinder smart collection "${project.name}"`
    });
    res.status(201).json(serialize(project, req.user, callerContext(req.user)));
  } catch (error) {
    sendProjectError(res, error, 'create smart collection');
  }
}

/** `PATCH /api/projects/:projectId` for a collection: its name and description. */
export function renameIFinderProject(serialize) {
  return async (req, res) => {
    try {
      const body = parse(ifinderProjectUpdateSchema, req, res);
      if (!body) return;
      const project = await renameCollection(req.user, req.project.id, body);
      logAudit({
        req,
        action: 'update',
        resource: 'project',
        resourceId: project.id,
        summary: `Updated iFinder smart collection "${projectName(project)}" (${Object.keys(body).join(', ')})`
      });
      res.json(serialize(project, req.user, req.projectContext));
    } catch (error) {
      sendProjectError(res, error, 'update smart collection');
    }
  };
}

/**
 * `POST /api/projects/:projectId/items` for a collection: `ifinder-document`
 * items only, one (`{kind, ref}`) or several (`{items: [...]}`).
 */
export async function addIFinderDocuments(req, res) {
  try {
    if (isMultipart(req)) {
      throw new ProjectError(
        'KIND_NOT_ALLOWED',
        'A project from iFinder holds iFinder documents only'
      );
    }
    const batch = Array.isArray(req.body?.items);
    const body = batch ? parse(ifinderAddItemsSchema, req, res) : parse(addItemSchema, req, res);
    if (!body) return;
    const requests = batch ? body.items : [body];
    const collectionId = collectionIdOf(req.project.id);
    const { project, added, alreadyMember } = await addDocuments(
      req.user,
      req.project.id,
      requests
    );
    if (added.length > 0) {
      logAudit({
        req,
        action: 'create',
        resource: 'projectItem',
        resourceId: project.id,
        summary: `Added ${added.length} iFinder document(s) to smart collection "${projectName(project)}"`
      });
    }
    const itemOf = documentId =>
      project.items.find(entry => entry.id === itemIdOf(collectionId, documentId));
    if (batch) {
      return res.status(added.length > 0 ? 201 : 200).json({
        items: [...added, ...alreadyMember].map(id => serializeItem(itemOf(id))),
        added,
        alreadyMember
      });
    }
    const [documentId] = [...added, ...alreadyMember];
    res
      .status(added.length > 0 ? 201 : 200)
      .json({ item: serializeItem(itemOf(documentId)), alreadyMember: added.length === 0 });
  } catch (error) {
    sendProjectError(res, error, 'add smart collection document');
  }
}

/** `DELETE /api/projects/:projectId/items/:itemId` for a collection: the membership only. */
export async function removeIFinderDocument(req, res) {
  try {
    const { project } = await removeDocuments(req.user, req.project.id, [req.params.itemId]);
    logAudit({
      req,
      action: 'delete',
      resource: 'projectItem',
      resourceId: project.id,
      summary: `Removed a document from smart collection "${projectName(project)}" (membership only)`
    });
    res.status(204).end();
  } catch (error) {
    sendProjectError(res, error, 'remove smart collection document');
  }
}
