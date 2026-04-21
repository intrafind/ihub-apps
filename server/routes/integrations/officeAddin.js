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
    redirectUri: `${baseUrl}/office/callback.html`
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

  const manifest = generateManifest({ baseUrl, origin, displayName, description });

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="manifest.xml"');
  res.send(manifest);
});

function generateManifest({ baseUrl, origin, displayName, description }) {
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
                <Control xsi:type="Button" id="msgReadOpenPaneButton">
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
                    <SourceLocation resid="Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
          <ExtensionPoint xsi:type="MessageComposeCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="msgComposeGroup">
                <Label resid="GroupLabel"/>
                <Control xsi:type="Button" id="msgComposeOpenPaneButton">
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
                    <SourceLocation resid="Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
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
      </bt:LongStrings>
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
                  <Control xsi:type="Button" id="msgReadOpenPaneButtonV1_1">
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
                      <SourceLocation resid="Taskpane.Url"/>
                      <SupportsPinning>true</SupportsPinning>
                    </Action>
                  </Control>
                </Group>
              </OfficeTab>
            </ExtensionPoint>
            <ExtensionPoint xsi:type="MessageComposeCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="msgComposeGroupV1_1">
                  <Label resid="GroupLabel"/>
                  <Control xsi:type="Button" id="msgComposeOpenPaneButtonV1_1">
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
                      <SourceLocation resid="Taskpane.Url"/>
                      <SupportsPinning>true</SupportsPinning>
                    </Action>
                  </Control>
                </Group>
              </OfficeTab>
            </ExtensionPoint>
          </DesktopFormFactor>
        </Host>
      </Hosts>
      <Resources>
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
        </bt:LongStrings>
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
