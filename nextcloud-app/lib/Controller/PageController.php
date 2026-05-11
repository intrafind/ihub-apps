<?php
declare(strict_types=1);

namespace OCA\IhubChat\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IConfig;
use OCP\IRequest;

/**
 * Renders the iframe host page. The actual iHub embed is loaded inside
 * an iframe from the iHub deployment configured via:
 *
 *   occ config:app:set ihub_chat ihub_base_url --value=https://ihub.example.com
 *   occ config:app:set ihub_chat ihub_provider_id --value=nextcloud-main
 *
 * The page expects the caller (the Files plugin frontend) to pass the
 * file selection in the URL hash (`#providerId=...&paths=...`). The
 * iframe inside reads the same hash via the iHub-side selection bridge.
 */
class PageController extends Controller {
    private IConfig $config;

    public function __construct(string $appName, IRequest $request, IConfig $config) {
        parent::__construct($appName, $request);
        $this->config = $config;
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function index(): TemplateResponse {
        $baseUrl = $this->config->getAppValue('ihub_chat', 'ihub_base_url', '');
        $providerId = $this->config->getAppValue('ihub_chat', 'ihub_provider_id', 'nextcloud-main');

        $response = new TemplateResponse('ihub_chat', 'main', [
            'ihubBaseUrl' => rtrim($baseUrl, '/'),
            'ihubProviderId' => $providerId,
        ]);

        // The iframe inside this page targets the iHub origin. Tell the
        // user's browser to allow `frame-src` for that origin so the
        // embed actually renders. Nextcloud's default CSP is otherwise
        // strict.
        $policy = $response->getContentSecurityPolicy();
        if ($policy !== null && $baseUrl !== '') {
            $policy->addAllowedFrameDomain($baseUrl);
            $response->setContentSecurityPolicy($policy);
        }

        return $response;
    }
}
