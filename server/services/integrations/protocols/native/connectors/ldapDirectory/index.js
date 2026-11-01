// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connector of the people directory installations
 * (`com.intrafind/ldap-directory`, one installation per directory): the
 * people search tools `<id>__search_people`, `<id>__get_person`,
 * `<id>__list_units` and the admin LDAP browser tools `<id>__browse_*` of
 * `services/peopleDirectory/`, with the parameters and descriptions each
 * directory had before it was an installation.
 *
 * The LDAP code is reused as it is: the installation is read in the directory
 * shape (`ldapDirectoryConfig.directoryFromInstance`), the tool listing stays
 * free of the LDAP client (the runner is imported when a tool runs or an admin
 * tests), and the directory's own access rules (`groups`, `browse.groups`)
 * keep holding through the `_peopleDirectory` marker on every tool.
 */
import {
  BROWSE_ACTIONS,
  buildBrowseTools,
  buildDirectoryTools,
  reportDirectoryProblemOnce,
  resolveDirectory,
  summarizeDirectory
} from '../../../../../peopleDirectory/PeopleDirectoryService.js';
import {
  DIRECTORY_BROWSE_ACTIONS,
  DIRECTORY_SEARCH_ACTIONS,
  directoryFromInstance
} from '../../../../ldapDirectoryConfig.js';

/** Resolved directories per instance object, for the six actions of one listing. */
const resolvedByInstance = new WeakMap();

function resolvedOf(ctx) {
  const instance = ctx.instance;
  const cached = resolvedByInstance.get(instance);
  if (cached) return cached;
  const resolved = resolveDirectory(directoryFromInstance({ ...instance, values: ctx.values }));
  resolvedByInstance.set(instance, resolved);
  return resolved;
}

/** The tool definition of one action as `buildDirectoryTools` / `buildBrowseTools` shape it. */
function toolOf(ctx, actionName) {
  const resolved = resolvedOf(ctx);
  const language = ctx.language || 'en';
  let tools;
  if (BROWSE_ACTIONS.includes(actionName)) {
    tools = resolved.browse ? buildBrowseTools(resolved, language) : [];
  } else if (actionName === 'list_units') {
    // The action exists in the definition whether or not units are on; its
    // schema is built as if they were, and `requires` decides availability.
    tools = buildDirectoryTools({ ...resolved, units: true }, language);
  } else {
    tools = buildDirectoryTools(resolved, language);
  }
  return tools.find(tool => tool._peopleDirectory?.action === actionName) || null;
}

/**
 * Whether the directory can serve the action: the configuration resolves
 * (reported once per directory), and for the browser its own settings hold.
 */
function available(ctx, actionName) {
  const resolved = resolvedOf(ctx);
  if (resolved.problems.length > 0) {
    reportDirectoryProblemOnce(
      `problems:${resolved.id}`,
      resolved.problems.join('|'),
      'People directory is not usable; its tools are not offered',
      { directoryId: resolved.id, problems: resolved.problems }
    );
    return false;
  }
  if (!BROWSE_ACTIONS.includes(actionName)) return true;
  if (!resolved.browse) return false;
  if (resolved.browse.problems.length > 0) {
    reportDirectoryProblemOnce(
      `browse:${resolved.id}`,
      resolved.browse.problems.join('|'),
      'LDAP browser of a people directory is not usable; its tools are not offered',
      { directoryId: resolved.id, problems: resolved.browse.problems }
    );
    return false;
  }
  return true;
}

function action(name) {
  const browse = BROWSE_ACTIONS.includes(name);
  return {
    parameters: ctx =>
      toolOf(ctx, name)?.parameters || { type: 'object', properties: {}, required: [] },
    description: ctx => toolOf(ctx, name)?.description || '',
    dataFlow: ctx => resolvedOf(ctx).dataFlow,
    available: ctx => available(ctx, name),
    /** The marker the access rules, `isToolSelected` and the MCP gateway read. */
    extras: ctx => ({
      readOnly: true,
      _peopleDirectory: { id: ctx.instance.id, action: name, ...(browse ? { browse: true } : {}) }
    }),
    async run(_args, ctx) {
      const { runPeopleDirectoryTool } =
        await import('../../../../../peopleDirectory/peopleDirectoryRunner.js');
      const tool = {
        id: `${ctx.instance.id}__${name}`,
        _peopleDirectory: { id: ctx.instance.id, action: name, ...(browse ? { browse: true } : {}) }
      };
      // `params` is everything the tool call received: the model's arguments
      // and iHub's context (`user`, `chatId`, `appConfig`), as the runner expects.
      const params = { ...(ctx.params || {}) };
      if (ctx.user && !params.user) params.user = ctx.user;
      if (ctx.chatId && !params.chatId) params.chatId = ctx.chatId;
      return runPeopleDirectoryTool(tool, params);
    }
  };
}

/**
 * The installation test: the directory's connection test (configuration,
 * address check, connect, StartTLS, bind, and with a sample name a search
 * with the mapped people), on the draft as the admin sees it.
 */
async function test({ instance, values, testInput }) {
  const { testDirectory } =
    await import('../../../../../peopleDirectory/peopleDirectoryRunner.js');
  const { getDirectoryInstallations } = await import('../../../../ldapDirectoryConfig.js');
  const saved = getDirectoryInstallations().some(entry => entry.id === instance.id);
  const directory = directoryFromInstance({ ...instance, values, enabled: true });
  const result = await testDirectory(directory, {
    query: typeof testInput?.query === 'string' ? testInput.query : undefined,
    unsaved: !saved
  });
  return result.steps;
}

const connector = {
  id: 'ldapDirectory',
  actions: Object.fromEntries(
    [...DIRECTORY_SEARCH_ACTIONS, ...DIRECTORY_BROWSE_ACTIONS].map(name => [name, action(name)])
  ),
  test,
  /**
   * For the installed list: whether the configuration resolves, the transport
   * (ldaps, starttls, plaintext) and whether the directory is external.
   */
  status(instance) {
    const summary = summarizeDirectory(directoryFromInstance(instance));
    return {
      connected: summary.problems.length === 0,
      transport: summary.transport,
      external: summary.external,
      browse: summary.browse,
      problems: summary.problems,
      warnings: summary.warnings
    };
  },
  async invalidate() {
    const { clearUnitsCache } =
      await import('../../../../../peopleDirectory/LdapDirectory.js');
    clearUnitsCache();
  },
  async onChanged() {
    await this.invalidate();
  }
};

export default connector;
