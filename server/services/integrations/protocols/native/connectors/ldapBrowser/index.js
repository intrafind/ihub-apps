// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connector of the admin LDAP browser installations
 * (`com.intrafind/ldap-browser`): the tools `<id>__browse_search`,
 * `<id>__browse_read` and `<id>__browse_children`.
 *
 * An installation names a People directory (LDAP) installation
 * (`values.directory`) and reuses its connection and, unless it has an
 * account of its own, its bind (`services/peopleDirectory/LdapBrowserService.js`).
 * The tool listing stays free of the LDAP client (the runner is imported when
 * a tool runs or an admin tests), and the browser's access rules — the
 * installation's group grant, signed-in non-delegated users only, the
 * directory enabled, never over the MCP gateway — keep holding through the
 * `_ldapBrowser` marker on every tool.
 */
import {
  buildBrowseTools,
  resolveBrowser,
  summarizeBrowser
} from '../../../../../peopleDirectory/LdapBrowserService.js';
import { reportDirectoryProblemOnce } from '../../../../../peopleDirectory/PeopleDirectoryService.js';
import {
  BROWSER_ACTIONS,
  browserFromInstance,
  getBrowserInstallations
} from '../../../../ldapDirectoryConfig.js';

/** Resolved browsers per instance object, for the three actions of one listing. */
const resolvedByInstance = new WeakMap();

function resolvedOf(ctx) {
  const instance = ctx.instance;
  const cached = resolvedByInstance.get(instance);
  if (cached) return cached;
  const resolved = resolveBrowser(browserFromInstance({ ...instance, values: ctx.values }));
  resolvedByInstance.set(instance, resolved);
  return resolved;
}

/** The tool definition of one action as `buildBrowseTools` shapes it. */
function toolOf(ctx, actionName) {
  const tools = buildBrowseTools(resolvedOf(ctx), ctx.language || 'en');
  return tools.find(tool => tool._ldapBrowser?.action === actionName) || null;
}

/**
 * Whether the browser can serve its actions: its configuration resolves
 * (reported once per browser) and the directory it reuses is enabled.
 */
function available(ctx) {
  const resolved = resolvedOf(ctx);
  if (resolved.problems.length > 0) {
    reportDirectoryProblemOnce(
      `browser:${resolved.id}`,
      resolved.problems.join('|'),
      'LDAP browser is not usable; its tools are not offered',
      { browserId: resolved.id, directoryId: resolved.directoryId, problems: resolved.problems }
    );
    return false;
  }
  return resolved.directoryEnabled;
}

function action(name) {
  const marker = ctx => ({
    id: ctx.instance.id,
    directory: resolvedOf(ctx).directoryId,
    action: name
  });
  return {
    parameters: ctx =>
      toolOf(ctx, name)?.parameters || { type: 'object', properties: {}, required: [] },
    description: ctx => toolOf(ctx, name)?.description || '',
    dataFlow: ctx => resolvedOf(ctx).dataFlow,
    available: ctx => available(ctx),
    /** The marker the access rules and the MCP gateway read. */
    extras: ctx => ({ readOnly: true, _ldapBrowser: marker(ctx) }),
    async run(_args, ctx) {
      const { runLdapBrowserTool } =
        await import('../../../../../peopleDirectory/ldapBrowserRunner.js');
      const browser = browserFromInstance({ ...ctx.instance, values: ctx.values });
      const tool = {
        id: `${ctx.instance.id}__${name}`,
        _ldapBrowser: { id: ctx.instance.id, directory: browser.directory, action: name }
      };
      // `params` is everything the tool call received: the model's arguments
      // and iHub's context (`user`, `chatId`, `appConfig`), as the runner expects.
      const params = { ...ctx.params };
      if (ctx.user && !params.user) params.user = ctx.user;
      if (ctx.chatId && !params.chatId) params.chatId = ctx.chatId;
      return runLdapBrowserTool(tool, params);
    }
  };
}

/**
 * The installation test: the browser's connection test (configuration with
 * the directory it reuses, address check, connect, StartTLS, bind with the
 * browser's account, and the children of the browse base), on the draft as
 * the admin sees it.
 */
async function test({ instance, values }) {
  const { testBrowser } = await import('../../../../../peopleDirectory/ldapBrowserRunner.js');
  const saved = getBrowserInstallations().some(entry => entry.id === instance.id);
  const browser = browserFromInstance({ ...instance, values, enabled: true });
  const result = await testBrowser(browser, { unsaved: !saved });
  return result.steps;
}

const connector = {
  id: 'ldapBrowser',
  actions: Object.fromEntries(BROWSER_ACTIONS.map(name => [name, action(name)])),
  test,
  /**
   * For the installed list: whether the configuration resolves, the transport
   * of the directory it reuses and whether that directory is external.
   */
  status(instance) {
    const summary = summarizeBrowser(browserFromInstance(instance));
    return {
      connected: summary.problems.length === 0 && summary.directoryEnabled,
      transport: summary.transport,
      external: summary.external,
      problems: summary.problems,
      warnings: summary.warnings
    };
  }
};

export default connector;
