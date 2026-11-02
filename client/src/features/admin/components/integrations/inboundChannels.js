// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The **Inbound** tab of Admin → Integrations: what connects *to* iHub, as
 * opposed to the installations iHub calls out to. Each entry links to the
 * page that configures it; its status is read from `platform.json`
 * (`GET /api/admin/configs/platform`).
 *
 * Pure module: the component translates `titleKey` / `descriptionKey`.
 *
 * @module features/admin/components/integrations/inboundChannels
 */

/**
 * The inbound channels in display order.
 * @type {ReadonlyArray<{
 *   id: string, href: string, icon: string, color: string,
 *   titleKey: string, titleDefault: string,
 *   descriptionKey: string, descriptionDefault: string,
 *   isOn: (platform: Object) => boolean
 * }>}
 */
export const INBOUND_INTEGRATIONS = Object.freeze([
  {
    id: 'outlook',
    href: '/admin/office-integration',
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
    icon: 'wrench',
    color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400',
    titleKey: 'admin.integrations.cards.browserExtension.title',
    titleDefault: 'Browser Extension',
    descriptionKey: 'admin.integrations.cards.browserExtension.description',
    descriptionDefault:
      'Side-panel extension for Chrome / Edge / Firefox. Run any iHub app against the page the user is reading.',
    isOn: platform => Boolean(platform?.features?.browserExtension)
  },
  {
    id: 'copilot-agent',
    href: '/admin/copilot-agent',
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
