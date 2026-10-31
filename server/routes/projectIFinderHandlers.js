// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The handlers of `/api/projects` for the iFinder tier: add one of the user's
 * smart collections to their projects (a stub), create a new collection (with
 * its stub), configure and rename it, add iFinder documents and remove them,
 * and delete the stub (and, when asked, the collection).
 *
 * A **stub** (`isCollectionStub`) is a stored user project that stands for one
 * collection: it keeps the default app, the instructions and the chats, while
 * the documents stay in the collection and are read with the owner's rights
 * (`projectLoader.js`). A collection project with an `ifc_` id (no stub) is
 * what chats attached before stubs existed still hold: it keeps reading, and
 * takes the three collection writes.
 *
 * They are the branch the allow-listed write routes take for both
 * (`IFINDER_WRITE_ROUTES` and `COLLECTION_STUB_WRITE_ROUTES` in
 * `middleware/projectAccess.js`); every other write route refuses them. The
 * work on the collection is the writer's
 * (`services/projects/ifinder/IFinderCollectionWriter.js`): here the request is
 * checked, the answer shaped and the change audited.
 *
 * @module routes/projectIFinderHandlers
 */
import { callerContext } from '../middleware/projectAccess.js';
import { logAudit } from '../services/AuditLogService.js';
import {
  collectionIdOf,
  ifinderProjectIdOf,
  isCollectionStub,
  isIFinderProjectId,
  smartCollectionIdOf
} from '../services/projects/projectConstants.js';
import { ProjectError } from '../services/projects/projectErrors.js';
import { getProjectService } from '../services/projects/ProjectService.js';
import { withCollection } from '../services/projects/projectLoader.js';
import {
  itemIdOf,
  listCollectionProjects,
  loadCollectionProject
} from '../services/projects/ifinder/IFinderTier.js';
import {
  addDocuments,
  createCollection,
  deleteCollection,
  removeDocuments,
  renameCollection
} from '../services/projects/ifinder/IFinderCollectionWriter.js';
import { projectName, serializeItem } from '../services/projects/projectView.js';
import {
  addItemSchema,
  collectionImportSchema,
  describeIssues,
  ifinderAddItemsSchema,
  ifinderProjectUpdateSchema,
  userProjectUpdateSchema
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
  return (req, res, next) =>
    isIFinderProjectId(req.project?.id) || isCollectionStub(req.project)
      ? handler(req, res)
      : next();
}

/** The `ifc_` id the writer takes for a collection project or a stub. */
function collectionProjectIdOf(project) {
  return ifinderProjectIdOf(smartCollectionIdOf(project));
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
 * `POST /api/projects` with `tier: 'ifinder'`: create a smart collection in
 * iFinder and its stub, which keeps the default app and the instructions. The
 * caller has passed the user-project gate; the body is already validated.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {{body: Object, serialize: (project: Object, user: Object, context: Object) => Object}} options
 */
export async function createIFinderProject(req, res, { body, serialize }) {
  try {
    const collection = await createCollection(req.user, {
      name: body.name,
      description: body.description || ''
    });
    const collectionId = collectionIdOf(collection.id);
    logAudit({
      req,
      action: 'create',
      resource: 'project',
      resourceId: collection.id,
      summary: `Created iFinder smart collection "${collection.name}"`
    });
    const stub = await getProjectService().createCollectionStub({
      owner: req.user,
      collectionId,
      content: {
        name: collection.name,
        description: collection.description || '',
        ...(body.instructions ? { instructions: body.instructions } : {}),
        ...(body.defaultAppId ? { defaultAppId: body.defaultAppId } : {})
      }
    });
    const project = {
      ...stub,
      items: collection.items,
      usage: { items: collection.items.length, bytes: 0 },
      collection: { id: collectionId, state: 'ok', name: collection.name }
    };
    res.status(201).json(serialize(project, req.user, callerContext(req.user)));
  } catch (error) {
    sendProjectError(res, error, 'create smart collection');
  }
}

/**
 * `GET /api/projects/_collections`: the caller's smart collections, each with
 * whether it is in their projects already (`projectId` of its stub). What the
 * catalog dialog offers to add. `available: false` while the tier is not
 * offered to the caller.
 *
 * @param {Object} req
 * @param {Object} res
 */
export async function listCollections(req, res) {
  try {
    const [listing, stubs] = await Promise.all([
      listCollectionProjects(req.user),
      getProjectService().collectionStubsOf(String(req.user.id))
    ]);
    const items = listing.projects.map(project => {
      const collectionId = collectionIdOf(project.id);
      const stub = stubs.get(collectionId);
      return {
        collectionId,
        name: project.name,
        description: project.description || '',
        documentCount: project.usage?.items ?? 0,
        updatedAt: project.updatedAt || null,
        added: Boolean(stub),
        ...(stub ? { projectId: stub.id } : {})
      };
    });
    res.json({
      available: listing.offered,
      items,
      truncated: listing.truncated === true,
      warnings: listing.warnings
    });
  } catch (error) {
    sendProjectError(res, error, 'list smart collections');
  }
}

/**
 * `POST /api/projects/_collections`: add one of the caller's smart collections
 * to their projects, as a stub with its default app and instructions. The
 * collection is asked for with the caller's rights first: iFinder answers 404
 * for one that is not theirs.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {{serialize: Function}} options
 */
export async function importCollection(req, res, { serialize }) {
  const parsed = collectionImportSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return sendBadRequest(res, `Invalid request: ${describeIssues(parsed.error)}`);
  }
  const body = parsed.data;
  try {
    const collectionId = body.collectionId.toLowerCase();
    const loaded = await loadCollectionProject(req.user, ifinderProjectIdOf(collectionId));
    if (loaded.status === 'unavailable') {
      throw new ProjectError('IFINDER_UNAVAILABLE', 'iFinder could not be reached');
    }
    if (loaded.status !== 'ok') throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
    const collection = loaded.project;
    const stub = await getProjectService().createCollectionStub({
      owner: req.user,
      collectionId,
      content: {
        name: collection.name,
        description: collection.description || '',
        ...(body.instructions ? { instructions: body.instructions } : {}),
        ...(body.defaultAppId ? { defaultAppId: body.defaultAppId } : {})
      }
    });
    logAudit({
      req,
      action: 'create',
      resource: 'project',
      resourceId: stub.id,
      summary: `Added iFinder smart collection "${collection.name}" to the projects`
    });
    const project = {
      ...stub,
      items: collection.items,
      usage: { items: collection.items.length, bytes: 0 },
      collection: { id: collectionId, state: 'ok', name: collection.name }
    };
    res.status(201).json(serialize(project, req.user, callerContext(req.user)));
  } catch (error) {
    sendProjectError(res, error, 'add smart collection');
  }
}

/**
 * `PATCH /api/projects/:projectId` for a smart collection.
 *
 * A stub takes what a user project takes: its name and description go to the
 * collection too (renamed in iFinder first, so the two never drift apart while
 * iFinder can be asked; a deleted collection renames the stub alone), the
 * default app and the instructions stay in iHub. A collection project (`ifc_`,
 * no stub) takes its name and description.
 */
export function renameIFinderProject(serialize) {
  return async (req, res) => {
    try {
      if (isCollectionStub(req.project)) return await updateStub(req, res, serialize);
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

async function updateStub(req, res, serialize) {
  const body = parse(userProjectUpdateSchema, req, res);
  if (!body) return;
  const stub = req.project;
  const state = stub.collection?.state;
  // Compared with what the collection is called now, not with the stored copy.
  const current = state === 'ok' ? stub.collection : stub;
  const rename = {};
  if (body.name !== undefined && body.name !== (current.name || stub.name)) {
    rename.name = body.name;
  }
  if (body.description !== undefined && body.description !== (current.description || '')) {
    rename.description = body.description;
  }
  if (Object.keys(rename).length > 0 && state !== 'deleted') {
    if (state !== 'ok') {
      throw new ProjectError(
        'IFINDER_UNAVAILABLE',
        'iFinder could not be reached, so the collection cannot be renamed right now'
      );
    }
    await renameCollection(req.user, collectionProjectIdOf(stub), rename);
  }
  const updated = await getProjectService().updateProject(stub.id, body, {
    actor: req.user,
    authorize: req.projectContext.authorize('edit')
  });
  logAudit({
    req,
    action: 'update',
    resource: 'project',
    resourceId: stub.id,
    summary: `Updated smart collection project "${projectName(updated || stub)}" (${Object.keys(body).join(', ')})`
  });
  const project = await withCollection(req.user, updated || stub);
  res.json(serialize(project, req.user, req.projectContext));
}

/**
 * `DELETE /api/projects/:projectId?deleteCollection=true` for a stub: delete the
 * collection in iFinder first (its documents stay), then hand on to the route
 * that deletes the stub with its chats' membership. Without the flag only the
 * stub goes; the collection stays in iFinder and can be added again.
 */
export async function deleteStubCollection(req, res, next) {
  if (!isCollectionStub(req.project) || String(req.query?.deleteCollection) !== 'true') {
    return next();
  }
  try {
    if (!req.projectPermissions?.isOwner) {
      throw new ProjectError(
        'PERMISSION_DENIED',
        'Only the owner deletes the smart collection in iFinder'
      );
    }
    if (req.project.collection?.state !== 'deleted') {
      await deleteCollection(req.user, req.project.source.collectionId);
      logAudit({
        req,
        action: 'delete',
        resource: 'project',
        resourceId: req.project.id,
        summary: `Deleted iFinder smart collection "${projectName(req.project)}"`
      });
    }
    next();
  } catch (error) {
    sendProjectError(res, error, 'delete smart collection');
  }
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
    const collectionProjectId = collectionProjectIdOf(req.project);
    const collectionId = collectionIdOf(collectionProjectId);
    const { project, added, alreadyMember } = await addDocuments(
      req.user,
      collectionProjectId,
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
    const { project } = await removeDocuments(req.user, collectionProjectIdOf(req.project), [
      req.params.itemId
    ]);
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
