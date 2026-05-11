<?php
declare(strict_types=1);

namespace OCA\IhubChat\Controller;

use OCA\IhubChat\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IConfig;
use OCP\IRequest;

/**
 * Renders the iframe host page. The actual iHub embed is loaded inside
 * an iframe from the iHub deployment configured via:
 *
 *   occ config:app:set ihub_chat ihub_base_url --value=https://ihub.example.com
 *   occ config:app:set ihub_chat ihub_provider_id --value=nextcloud-main
 *
 * Config values are pushed to the JS bundle via IInitialState (consumed
 * with `loadState('ihub_chat', …)`). The page expects the caller (the
 * Files plugin frontend) to pass the file selection in the URL hash
 * (`#providerId=…&paths=…`).
 */
class PageController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private readonly IConfig $config,
        private readonly IInitialState $initialState,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function index(): TemplateResponse {
        $baseUrl = $this->config->getAppValue(Application::APP_ID, 'ihub_base_url', '');
        $providerId = $this->config->getAppValue(
            Application::APP_ID,
            'ihub_provider_id',
            'nextcloud-main',
        );

        $this->initialState->provideInitialState('baseUrl', rtrim($baseUrl, '/'));
        $this->initialState->provideInitialState('providerId', $providerId);

        // The template only needs the base-url-set flag so it can render the
        // config-missing fallback synchronously (the iframe gets created from
        // JS that reads the same value via loadState).
        $response = new TemplateResponse(Application::APP_ID, 'main', [
            'baseUrlConfigured' => $baseUrl !== '',
        ]);

        // Allow the iframe inside this page to target the iHub origin.
        // Nextcloud's default CSP is otherwise strict on `frame-src`.
        $policy = $response->getContentSecurityPolicy();
        if ($policy !== null && $baseUrl !== '') {
            $policy->addAllowedFrameDomain($baseUrl);
            $response->setContentSecurityPolicy($policy);
        }

        return $response;
    }
}
