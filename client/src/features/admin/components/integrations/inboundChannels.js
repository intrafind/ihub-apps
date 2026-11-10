// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What connects *to* iHub, as opposed to the installations iHub calls out
 * to: the **Inbound** tab of Admin → Integrations lists every channel, and
 * the **Clients** section heading the Installed tab lists the ones users
 * work in (`client: true`). Each entry links to the page that configures it;
 * its status is read from `platform.json` (`GET /api/admin/configs/platform`).
 *
 * Pure module: the components translate `titleKey` / `descriptionKey`.
 *
 * @module features/admin/components/integrations/inboundChannels
 */

/**
 * The inbound channels in display order.
 * @type {ReadonlyArray<{
 *   id: string, href: string, icon: string, color: string, client: boolean,
 *   titleKey: string, titleDefault: string,
 *   descriptionKey: string, descriptionDefault: string,
 *   isOn: (platform: Object) => boolean
 * }>}
 */
export const INBOUND_INTEGRATIONS = Object.freeze([
  {
    id: 'outlook',
    href: '/admin/office-integration',
    client: true,
    icon: 'mail',
    color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400',
    titleKey: 'admin.integrations.cards.outlook.title',
    titleDefault: 'Outlook Add-in',
    descriptionKey: 'admin.integrations.cards.outlook.description',
    descriptionDefault:
      'Embed iHub apps inside the Outlook task pane. Users sign in with their iHub account and run prompts against the currently selected email.',
    isOn: platform =>
      Boolean(platform?.features?.outlookAddIn || platform?.officeIntegration?.enabled)
  },
  {
    id: 'browser-extension',
    href: '/admin/browser-extension',
    client: true,
    icon: 'wrench',
    color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400',
    titleKey: 'admin.integrations.cards.browserExtension.title',
    titleDefault: 'Browser Extension',
    descriptionKey: 'admin.integrations.cards.browserExtension.description',
    descriptionDefault:
      'Side-panel extension for Chrome / Edge / Firefox. Run any iHub app against the page the user is reading.',
    // `_enable` / `_disable` switch `browserExtension.enabled`; no feature flag exists.
    isOn: platform => Boolean(platform?.browserExtension?.enabled)
  },
  {
    id: 'copilot-agent',
    href: '/admin/copilot-agent',
    client: true,
    icon: 'sparkles',
    color: 'bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400',
    titleKey: 'admin.integrations.cards.copilotAgent.title',
    titleDefault: 'Microsoft 365 Copilot',
    descriptionKey: 'admin.integrations.cards.copilotAgent.description',
    descriptionDefault:
      "Make iHub an agent in Microsoft 365 Copilot. Copilot runs iHub's apps through the MCP gateway, signed in with the user's iHub account.",
    isOn: platform => Boolean(platform?.copilotAgent?.enabled)
  },
  {
    id: 'nextcloud-embed',
    href: '/admin/nextcloud-embed',
    client: true,
    icon: 'cloud',
    color: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-400',
    titleKey: 'admin.integrations.cards.nextcloudEmbed.title',
    titleDefault: 'Nextcloud Embed',
    descriptionKey: 'admin.integrations.cards.nextcloudEmbed.description',
    descriptionDefault:
      'Embed iHub inside Nextcloud. Users start a chat from Nextcloud Files with documents pre-attached, similar to the Outlook add-in.',
    isOn: platform => Boolean(platform?.nextcloudEmbed?.enabled)
  },
  {
    id: 'mcp-gateway',
    href: '/admin/mcp/gateway',
    client: false,
    icon: 'cpu-chip',
    color: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400',
    titleKey: 'admin.integrations.cards.mcpGateway.title',
    titleDefault: 'MCP gateway',
    descriptionKey: 'admin.integrations.cards.mcpGateway.description',
    descriptionDefault:
      "Let external MCP clients use iHub's apps as tools, signed in through iHub's own OAuth server.",
    isOn: platform => Boolean(platform?.mcpServer?.enabled)
  }
]);

/** The channels users work in: the Clients section of the Installed tab. */
export const CLIENT_INTEGRATIONS = Object.freeze(
  INBOUND_INTEGRATIONS.filter(entry => entry.client)
);

/**
 * The heading of the Clients section, in the shape of an `integrationGroups`
 * group (without `items`), for `IntegrationGroupSection`.
 */
export const CLIENTS_GROUP = Object.freeze({
  id: 'clients',
  titleKey: 'admin.integrations.groups.clients.title',
  titleDefault: 'Clients',
  descriptionKey: 'admin.integrations.groups.clients.description',
  descriptionDefault:
    'Where users work with iHub outside the web app: Outlook, the browser, Nextcloud and Microsoft 365 Copilot. Each one is set up on its own page.'
});

/**
 * Whether an inbound channel matches the search text: its id, its title or
 * description in the current language, or the English default.
 *
 * @param {(typeof INBOUND_INTEGRATIONS)[number]} entry
 * @param {string} query - lower-cased, trimmed
 * @param {(key: string, fallback: string) => string} translate - i18next `t`
 * @returns {boolean}
 */
export function matchesInboundQuery(entry, query, translate) {
  if (!query) return true;
  const texts = [
    entry.id,
    entry.titleDefault,
    entry.descriptionDefault,
    translate(entry.titleKey, entry.titleDefault),
    translate(entry.descriptionKey, entry.descriptionDefault)
  ];
  return texts.some(text => typeof text === 'string' && text.toLowerCase().includes(query));
}

/**
 * The status pill of an inbound channel: `connected` while it is switched
 * on, `available` otherwise and while the platform config is unknown.
 *
 * @param {(typeof INBOUND_INTEGRATIONS)[number]} entry
 * @param {Object|null} platform - `platform.json`, or null when it could not be read
 * @returns {'connected'|'available'}
 */
export function inboundStatus(entry, platform) {
  if (!platform) return 'available';
  return entry.isOn(platform) ? 'connected' : 'available';
}
