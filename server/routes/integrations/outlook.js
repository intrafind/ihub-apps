import express from 'express';
import { buildServerPath } from '../../utils/basePath.js';
import { authRequired } from '../../middleware/authRequired.js';

const router = express.Router();

/**
 * Generate Outlook Add-in manifest dynamically
 * GET /api/integrations/outlook/manifest.xml
 */
function registerOutlookIntegrationRoutes(app, { basePath = '' }) {
  /**
   * @swagger
   * /api/integrations/outlook/manifest.xml:
   *   get:
   *     summary: Generate Outlook Add-in manifest
   *     description: Dynamically generates the Office Add-in manifest with correct server URLs
   *     tags:
   *       - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Manifest XML file
   *         content:
   *           application/xml:
   *             schema:
   *               type: string
   *       401:
   *         description: Authentication required
   */
  app.get(
    buildServerPath('/api/integrations/outlook/manifest.xml', basePath),
    authRequired,
    (req, res) => {
      try {
        // Get the server URL from request
        const protocol = req.protocol;
        const host = req.get('host');
        const appUrl = `${protocol}://${host}`;

        // Generate unique ID (in production, this should be stored/consistent)
        const addInId = process.env.OUTLOOK_ADDIN_ID || 'f7b5e5c3-4a1b-4e2d-8f3a-9c7d6e5f4a3b';

        const manifestXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:mailappor="http://schemas.microsoft.com/office/mailappversionoverrides/1.0"
           xsi:type="MailApp">
  
  <!-- Begin Basic Settings: Add-in metadata, used for all versions of Office unless override provided. -->
  <Id>${addInId}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>iHub Apps</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  
  <DisplayName DefaultValue="iHub Apps - AI Assistant"/>
  <Description DefaultValue="Summarize emails, generate replies, and analyze attachments using AI"/>
  <IconUrl DefaultValue="${appUrl}/outlook/assets/icon-64.png"/>
  <HighResolutionIconUrl DefaultValue="${appUrl}/outlook/assets/icon-128.png"/>
  <SupportUrl DefaultValue="${appUrl}/page/help"/>
  
  <!-- End Basic Settings. -->
  
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
        <SourceLocation DefaultValue="${appUrl}/outlook/taskpane.html"/>
        <RequestedHeight>450</RequestedHeight>
      </DesktopSettings>
    </Form>
  </FormSettings>
  
  <Permissions>ReadWriteItem</Permissions>
  
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>
  </Rule>
  
  <!-- Version Overrides for additional functionality -->
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
      
      <Requirements>
        <bt:Sets DefaultMinVersion="1.3">
          <bt:Set Name="Mailbox"/>
        </bt:Sets>
      </Requirements>
      
      <Hosts>
        <Host xsi:type="MailHost">
          
          <!-- Message Read Mode -->
          <DesktopFormFactor>
            <FunctionFile resid="Commands.Url"/>
            
            <!-- Message Read Command Surface -->
            <ExtensionPoint xsi:type="MessageReadCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="msgReadGroup">
                  <Label resid="GroupLabel"/>
                  
                  <!-- Summarize Email Button -->
                  <Control xsi:type="Button" id="msgReadSummarizeButton">
                    <Label resid="SummarizeButtonLabel"/>
                    <Supertip>
                      <Title resid="SummarizeButtonLabel"/>
                      <Description resid="SummarizeButtonTooltip"/>
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
                  
                  <!-- Generate Reply Button -->
                  <Control xsi:type="Button" id="msgReadReplyButton">
                    <Label resid="ReplyButtonLabel"/>
                    <Supertip>
                      <Title resid="ReplyButtonLabel"/>
                      <Description resid="ReplyButtonTooltip"/>
                    </Supertip>
                    <Icon>
                      <bt:Image size="16" resid="Icon.16x16"/>
                      <bt:Image size="32" resid="Icon.32x32"/>
                      <bt:Image size="80" resid="Icon.80x80"/>
                    </Icon>
                    <Action xsi:type="ShowTaskpane">
                      <SourceLocation resid="TaskpaneReply.Url"/>
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
          <bt:Image id="Icon.16x16" DefaultValue="${appUrl}/outlook/assets/icon-16.png"/>
          <bt:Image id="Icon.32x32" DefaultValue="${appUrl}/outlook/assets/icon-32.png"/>
          <bt:Image id="Icon.80x80" DefaultValue="${appUrl}/outlook/assets/icon-80.png"/>
        </bt:Images>
        <bt:Urls>
          <bt:Url id="Commands.Url" DefaultValue="${appUrl}/outlook/commands.html"/>
          <bt:Url id="Taskpane.Url" DefaultValue="${appUrl}/outlook/taskpane.html?action=summarize"/>
          <bt:Url id="TaskpaneReply.Url" DefaultValue="${appUrl}/outlook/taskpane.html?action=reply"/>
        </bt:Urls>
        <bt:ShortStrings>
          <bt:String id="GroupLabel" DefaultValue="iHub AI"/>
          <bt:String id="SummarizeButtonLabel" DefaultValue="Summarize Email"/>
          <bt:String id="ReplyButtonLabel" DefaultValue="Generate Reply"/>
        </bt:ShortStrings>
        <bt:LongStrings>
          <bt:String id="SummarizeButtonTooltip" DefaultValue="Use AI to summarize this email"/>
          <bt:String id="ReplyButtonTooltip" DefaultValue="Generate an AI-powered reply to this email"/>
        </bt:LongStrings>
      </Resources>
    </VersionOverrides>
  </VersionOverrides>
  
</OfficeApp>`;

        res.set('Content-Type', 'application/xml');
        res.set('Content-Disposition', 'attachment; filename="ihub-outlook-manifest.xml"');
        res.send(manifestXml);
      } catch (error) {
        console.error('Error generating manifest:', error);
        res.status(500).json({ error: 'Failed to generate manifest' });
      }
    }
  );

  /**
   * @swagger
   * /api/integrations/outlook/info:
   *   get:
   *     summary: Get Outlook integration information
   *     description: Returns information about the Outlook integration setup
   *     tags:
   *       - Integrations
   *     responses:
   *       200:
   *         description: Integration information
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 enabled:
   *                   type: boolean
   *                 manifestUrl:
   *                   type: string
   *                 serverUrl:
   *                   type: string
   *                 instructions:
   *                   type: string
   */
  app.get(
    buildServerPath('/api/integrations/outlook/info', basePath),
    (req, res) => {
      const protocol = req.protocol;
      const host = req.get('host');
      const appUrl = `${protocol}://${host}`;

      res.json({
        enabled: true,
        name: 'Outlook Add-in for Mac',
        manifestUrl: `${appUrl}/api/integrations/outlook/manifest.xml`,
        serverUrl: appUrl,
        taskpaneUrl: `${appUrl}/outlook/taskpane.html`,
        instructions: `
1. Download the manifest file from the manifest URL
2. Open Outlook for Mac
3. Go to Get Add-ins → My Add-ins
4. Click "Add a Custom Add-in" → "Add from File"
5. Select the downloaded manifest file
6. The add-in will appear in your Outlook ribbon
        `.trim(),
        authentication: {
          type: 'server-side',
          description:
            'Authentication is handled by the iHub server. The add-in uses the same authentication as the main application.',
          note: 'Email content is sent to the iHub server for AI processing. Ensure proper authentication and authorization are configured on the server.'
        },
        features: [
          {
            name: 'Email Summarization',
            description: 'Summarize emails using AI',
            app: 'summarizer'
          },
          {
            name: 'Reply Generation',
            description: 'Generate professional email responses',
            app: 'email-composer'
          },
          {
            name: 'Attachment Analysis',
            description: 'Analyze email attachments',
            app: 'summarizer'
          }
        ]
      });
    }
  );
}

export default registerOutlookIntegrationRoutes;
