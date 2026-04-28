// Office Add-in Integration Routes
// Serves runtime configuration and generates the Office manifest XML

import express from 'express';
import { requireFeature } from '../../featureRegistry.js';
import { getBasePath } from '../../utils/basePath.js';
import configCache from '../../configCache.js';
import { getLocalizedContent } from '../../../shared/localize.js';
import logger from '../../utils/logger.js';

const router = express.Router();

// Gate all Office add-in routes behind the integrations feature flag
router.use(requireFeature('integrations'));

/**
 * Build the public base URL from the incoming request, honouring
 * any X-Forwarded-* / X-Forwarded-Prefix headers set by a reverse proxy.
 */
function buildPublicBaseUrl(req) {
  const proto = req.get('X-Forwarded-Proto') || req.protocol || 'https';
  const host = req.get('X-Forwarded-Host') || req.get('host');
  const basePath = getBasePath();
  return `${proto}://${host}${basePath}`;
}

/**
 * Keep only `{ [lang: string]: string }` entries. Defensive sanitizer used on the
 * public add-in config endpoint so a manually corrupted platform.json can't crash
 * the taskpane during rendering.
 */
function sanitizeLocalizedObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [lang, val] of Object.entries(value)) {
    if (typeof lang === 'string' && typeof val === 'string') out[lang] = val;
  }
  return out;
}

function sanitizeStarterPrompts(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const title = sanitizeLocalizedObject(item.title);
    const message = sanitizeLocalizedObject(item.message);
    if (Object.keys(title).length === 0 || Object.keys(message).length === 0) continue;
    out.push({ title, message });
  }
  return out;
}

function sanitizeQuickActions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!item.appId || typeof item.appId !== 'string' || item.appId.trim() === '') continue;
    const label = sanitizeLocalizedObject(item.label);
    if (Object.keys(label).length === 0) continue;
    const entry = { appId: item.appId.trim(), label };
    const prompt = sanitizeLocalizedObject(item.prompt);
    if (Object.keys(prompt).length > 0) entry.prompt = prompt;
    out.push(entry);
  }
  return out;
}

/**
 * @swagger
 * /api/integrations/office-addin/config:
 *   get:
 *     summary: Get Office add-in runtime configuration
 *     description: Returns runtime configuration needed by the Outlook add-in before it can authenticate. No authentication required.
 *     tags:
 *       - Integrations - Office Add-in
 *     responses:
 *       200:
 *         description: Runtime configuration object
 *       404:
 *         description: Office integration not enabled
 */
router.get('/config', (req, res) => {
  const platform = configCache.getPlatform();
  const officeConfig = platform?.officeIntegration;

  if (!officeConfig?.enabled) {
    return res.status(404).json({ error: 'Office integration is not enabled' });
  }

  const baseUrl = buildPublicBaseUrl(req);

  res.json({
    baseUrl,
    clientId: officeConfig.oauthClientId || '',
    redirectUri: `${baseUrl}/office/callback.html`,
    starterPrompts: sanitizeStarterPrompts(officeConfig.starterPrompts),
    quickActions: sanitizeQuickActions(officeConfig.quickActions)
  });
});

/**
 * @swagger
 * /api/integrations/office-addin/manifest.xml:
 *   get:
 *     summary: Get Office add-in manifest
 *     description: Dynamically generates the Office add-in manifest XML with correct URLs for this deployment.
 *     tags:
 *       - Integrations - Office Add-in
 *     responses:
 *       200:
 *         description: Office manifest XML
 *         content:
 *           application/xml:
 *             schema:
 *               type: string
 *       404:
 *         description: Office integration not enabled
 */
router.get('/manifest.xml', (req, res) => {
  const platform = configCache.getPlatform();
  const officeConfig = platform?.officeIntegration;

  if (!officeConfig?.enabled) {
    return res.status(404).json({ error: 'Office integration is not enabled' });
  }

  const baseUrl = buildPublicBaseUrl(req);
  const origin = new URL(baseUrl).origin;
  const lang = req.acceptsLanguages('de', 'en') === 'de' ? 'de' : 'en';
  const displayName = getLocalizedContent(officeConfig.displayName, lang) || 'iHub Apps';
  const description =
    getLocalizedContent(officeConfig.description, lang) || 'AI-powered assistant for Outlook';

  logger.debug('Generating Office manifest', {
    component: 'OfficeAddinRoutes',
    baseUrl,
    displayName
  });

  const quickActions = sanitizeQuickActions(officeConfig.quickActions);
  const manifest = generateManifest({ baseUrl, origin, displayName, description, quickActions });

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="manifest.xml"');
  res.send(manifest);
});

function generateManifest({ baseUrl, origin, displayName, description, quickActions = [] }) {
  function generateMenuItems(qas, supportsPinning, context) {
    const items = qas
      .map(
        (qa, i) => `\
                  <Item id="QuickAction_${i}_${context}">
                    <Label resid="QuickAction_${i}.Label"/>
                    <Supertip>
                      <Title resid="QuickAction_${i}.Label"/>
                      <Description resid="QuickAction_${i}.Label"/>
                    </Supertip>
                    <Icon>
                      <bt:Image size="16" resid="Icon.16x16"/>
                      <bt:Image size="32" resid="Icon.32x32"/>
                      <bt:Image size="80" resid="Icon.80x80"/>
                    </Icon>
                    <Action xsi:type="ShowTaskpane">
                      <SourceLocation resid="QuickAction_${i}.Url"/>${supportsPinning ? '\n                      <SupportsPinning>true</SupportsPinning>' : ''}
                    </Action>
                  </Item>`
      )
      .join('\n');
    const openItem = `\
                  <Item id="OpenChat_${context}">
                    <Label resid="OpenChat.Label"/>
                    <Supertip>
                      <Title resid="OpenChat.Label"/>
                      <Description resid="OpenChat.Label"/>
                    </Supertip>
                    <Icon>
                      <bt:Image size="16" resid="Icon.16x16"/>
                      <bt:Image size="32" resid="Icon.32x32"/>
                      <bt:Image size="80" resid="Icon.80x80"/>
                    </Icon>
                    <Action xsi:type="ShowTaskpane">
                      <SourceLocation resid="Taskpane.Url"/>${supportsPinning ? '\n                      <SupportsPinning>true</SupportsPinning>' : ''}
                    </Action>
                  </Item>`;
    return `${items}\n${openItem}`;
  }

  function generateQuickActionResources(qas) {
    const urls = qas
      .map(
        (_, i) =>
          `        <bt:Url id="QuickAction_${i}.Url" DefaultValue="${baseUrl}/office/taskpane.html?qa=${i}"/>`
      )
      .join('\n');
    const strings = qas
      .map(
        (qa, i) =>
          `        <bt:String id="QuickAction_${i}.Label" DefaultValue="${escapeXml(qa.label?.en ?? '')}"/>`
      )
      .join('\n');
    return { urls, strings };
  }

  const hasQuickActions = quickActions.length > 0;

  function renderControl(id, groupSuffix, supportsPinning) {
    if (!hasQuickActions) {
      return `\
                <Control xsi:type="Button" id="${id}">
                  <Label resid="TaskpaneButton.Label"/>
                  <Supertip>
                    <Title resid="TaskpaneButton.Label"/>
                    <Description resid="TaskpaneButton.Tooltip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16x16"/>
                    <bt:Image size="32" resid="Icon.32x32"/>
                    <bt:Image size="80" resid="Icon.80x80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <SourceLocation resid="Taskpane.Url"/>${supportsPinning ? '\n                    <SupportsPinning>true</SupportsPinning>' : ''}
                  </Action>
                </Control>`;
    }
    return `\
                <Control xsi:type="Menu" id="${id}">
                  <Label resid="MenuButton.Label"/>
                  <Supertip>
                    <Title resid="MenuButton.Label"/>
                    <Description resid="TaskpaneButton.Tooltip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16x16"/>
                    <bt:Image size="32" resid="Icon.32x32"/>
                    <bt:Image size="80" resid="Icon.80x80"/>
                  </Icon>
                  <Items>
${generateMenuItems(quickActions, supportsPinning, groupSuffix)}
                  </Items>
                </Control>`;
  }

  function renderResources(qas) {
    if (!hasQuickActions) {
      return `\
      <bt:Images>
        <bt:Image id="Icon.16x16" DefaultValue="${baseUrl}/office/assets/icon-16.png"/>
        <bt:Image id="Icon.32x32" DefaultValue="${baseUrl}/office/assets/icon-32.png"/>
        <bt:Image id="Icon.80x80" DefaultValue="${baseUrl}/office/assets/icon-80.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Commands.Url" DefaultValue="${baseUrl}/office/commands.html"/>
        <bt:Url id="Taskpane.Url" DefaultValue="${baseUrl}/office/taskpane.html"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="GroupLabel" DefaultValue="${escapeXml(displayName)} Add-in"/>
        <bt:String id="TaskpaneButton.Label" DefaultValue="Show Task Pane"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="TaskpaneButton.Tooltip" DefaultValue="${escapeXml(description)}"/>
      </bt:LongStrings>`;
    }
    const { urls, strings } = generateQuickActionResources(qas);
    return `\
      <bt:Images>
        <bt:Image id="Icon.16x16" DefaultValue="${baseUrl}/office/assets/icon-16.png"/>
        <bt:Image id="Icon.32x32" DefaultValue="${baseUrl}/office/assets/icon-32.png"/>
        <bt:Image id="Icon.80x80" DefaultValue="${baseUrl}/office/assets/icon-80.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Commands.Url" DefaultValue="${baseUrl}/office/commands.html"/>
        <bt:Url id="Taskpane.Url" DefaultValue="${baseUrl}/office/taskpane.html"/>
${urls}
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="GroupLabel" DefaultValue="${escapeXml(displayName)} Add-in"/>
        <bt:String id="TaskpaneButton.Label" DefaultValue="Show Task Pane"/>
        <bt:String id="MenuButton.Label" DefaultValue="${escapeXml(displayName)}"/>
        <bt:String id="OpenChat.Label" DefaultValue="Open ${escapeXml(displayName)}"/>
${strings}
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="TaskpaneButton.Tooltip" DefaultValue="${escapeXml(description)}"/>
      </bt:LongStrings>`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:mailappor="http://schemas.microsoft.com/office/mailappversionoverrides/1.0"
           xsi:type="MailApp">
  <Id>4fe644da-8036-47f8-ac9f-e478bcbe5274</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>intrafind</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="${escapeXml(displayName)}"/>
  <Description DefaultValue="${escapeXml(description)}"/>
  <IconUrl DefaultValue="${baseUrl}/office/assets/icon-64.png"/>
  <HighResolutionIconUrl DefaultValue="${baseUrl}/office/assets/icon-128.png"/>
  <SupportUrl DefaultValue="${origin}"/>
  <AppDomains>
    <AppDomain>${origin}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="Mailbox" MinVersion="1.1"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings>
        <SourceLocation DefaultValue="${baseUrl}/office/taskpane.html"/>
        <RequestedHeight>250</RequestedHeight>
      </DesktopSettings>
    </Form>
    <Form xsi:type="ItemEdit">
      <DesktopSettings>
        <SourceLocation DefaultValue="${baseUrl}/office/taskpane.html"/>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadWriteItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>
  </Rule>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Requirements>
      <bt:Sets DefaultMinVersion="1.3">
        <bt:Set Name="Mailbox"/>
      </bt:Sets>
    </Requirements>
    <Hosts>
      <Host xsi:type="MailHost">
        <DesktopFormFactor>
          <FunctionFile resid="Commands.Url"/>
          <ExtensionPoint xsi:type="MessageReadCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="msgReadGroup">
                <Label resid="GroupLabel"/>
${renderControl('msgReadMenuButton', 'msgRead', false)}
              </Group>
            </OfficeTab>
          </ExtensionPoint>
          <ExtensionPoint xsi:type="MessageComposeCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="msgComposeGroup">
                <Label resid="GroupLabel"/>
${renderControl('msgComposeMenuButton', 'msgCompose', false)}
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
${renderResources(quickActions)}
    </Resources>
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
      <Requirements>
        <bt:Sets DefaultMinVersion="1.5">
          <bt:Set Name="Mailbox"/>
        </bt:Sets>
      </Requirements>
      <Hosts>
        <Host xsi:type="MailHost">
          <DesktopFormFactor>
            <FunctionFile resid="Commands.Url"/>
            <ExtensionPoint xsi:type="MessageReadCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="msgReadGroupV1_1">
                  <Label resid="GroupLabel"/>
${renderControl('msgReadMenuButtonV1_1', 'msgReadV1_1', true)}
                </Group>
              </OfficeTab>
            </ExtensionPoint>
            <ExtensionPoint xsi:type="MessageComposeCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="msgComposeGroupV1_1">
                  <Label resid="GroupLabel"/>
${renderControl('msgComposeMenuButtonV1_1', 'msgComposeV1_1', true)}
                </Group>
              </OfficeTab>
            </ExtensionPoint>
          </DesktopFormFactor>
        </Host>
      </Hosts>
      <Resources>
${renderResources(quickActions)}
      </Resources>
    </VersionOverrides>
  </VersionOverrides>
</OfficeApp>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default router;
