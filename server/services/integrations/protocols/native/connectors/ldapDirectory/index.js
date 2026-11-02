// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connector of the people directory installations
 * (`com.intrafind/ldap-directory`, "People directory (LDAP)", one
 * installation per directory): the people search tools
 * `<id>__search_people`, `<id>__get_person` and `<id>__list_units` of
 * `services/peopleDirectory/`, with the parameters and descriptions each
 * directory had before it was an installation.
 *
 * The admin LDAP browser is a connector of its own (`ldapBrowser`), whose
 * installations reuse a directory's connection.
 *
 * The LDAP code is reused as it is: the installation is read in the directory
 * shape (`ldapDirectoryConfig.directoryFromInstance`), the tool listing stays
 * free of the LDAP client (the runner is imported when a tool runs or an admin
 * tests), and the directory's access rule (the group grant of the
 * installation) keeps holding through the `_peopleDirectory` marker on every
 * tool.
 */
import {
  buildDirectoryTools,
  reportDirectoryProblemOnce,
  resolveDirectory,
  summarizeDirectory
} from '../../../../../peopleDirectory/PeopleDirectoryService.js';
import {
  DIRECTORY_SEARCH_ACTIONS,
  directoryFromInstance
} from '../../../../ldapDirectoryConfig.js';

/** Resolved directories per instance object, for the three actions of one listing. */
const resolvedByInstance = new WeakMap();

function resolvedOf(ctx) {
  const instance = ctx.instance;
  const cached = resolvedByInstance.get(instance);
  if (cached) return cached;
  const resolved = resolveDirectory(directoryFromInstance({ ...instance, values: ctx.values }));
  resolvedByInstance.set(instance, resolved);
  return resolved;
}

/** The tool definition of one action as `buildDirectoryTools` shapes it. */
function toolOf(ctx, actionName) {
  const resolved = resolvedOf(ctx);
  const language = ctx.language || 'en';
  // The action `list_units` exists in the definition whether or not units are
  // on; its schema is built as if they were, and `requires` decides availability.
  const tools =
    actionName === 'list_units'
      ? buildDirectoryTools({ ...resolved, units: true }, language)
      : buildDirectoryTools(resolved, language);
  return tools.find(tool => tool._peopleDirectory?.action === actionName) || null;
}

/** Whether the directory can serve its actions: the configuration resolves (reported once). */
function available(ctx) {
  const resolved = resolvedOf(ctx);
  if (resolved.problems.length === 0) return true;
  reportDirectoryProblemOnce(
    `problems:${resolved.id}`,
    resolved.problems.join('|'),
    'People directory is not usable; its tools are not offered',
    { directoryId: resolved.id, problems: resolved.problems }
  );
  return false;
}

function action(name) {
  return {
    parameters: ctx =>
      toolOf(ctx, name)?.parameters || { type: 'object', properties: {}, required: [] },
    description: ctx => toolOf(ctx, name)?.description || '',
    dataFlow: ctx => resolvedOf(ctx).dataFlow,
    available: ctx => available(ctx),
    /** The marker the access rules, `isToolSelected` and the MCP gateway read. */
    extras: ctx => ({
      readOnly: true,
      _peopleDirectory: { id: ctx.instance.id, action: name }
    }),
    async run(_args, ctx) {
      const { runPeopleDirectoryTool } =
        await import('../../../../../peopleDirectory/peopleDirectoryRunner.js');
      const tool = {
        id: `${ctx.instance.id}__${name}`,
        _peopleDirectory: { id: ctx.instance.id, action: name }
      };
      // `params` is everything the tool call received: the model's arguments
      // and iHub's context (`user`, `chatId`, `appConfig`), as the runner expects.
      const params = { ...ctx.params };
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
  const { testDirectory } = await import('../../../../../peopleDirectory/peopleDirectoryRunner.js');
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
  actions: Object.fromEntries(DIRECTORY_SEARCH_ACTIONS.map(name => [name, action(name)])),
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
      problems: summary.problems,
      warnings: summary.warnings
    };
  },
  async invalidate() {
    const { clearUnitsCache } = await import('../../../../../peopleDirectory/LdapDirectory.js');
    clearUnitsCache();
  },
  async onChanged() {
    await this.invalidate();
  }
};

export default connector;
