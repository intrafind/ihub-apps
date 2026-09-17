<?php
declare(strict_types=1);

namespace OCA\IhubChat\Listener;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\IhubChat\AppInfo\Application;
use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IConfig;
use OCP\Util;

/**
 * Listens for `LoadAdditionalScriptsEvent` (fired when the Files app is
 * rendered for any user) and injects:
 *
 *   - The Files-page JS bundle (`js/ihub_chat-files-init.mjs`) — registers
 *     the "Chat with iHub" file action via the @nextcloud/files API.
 *   - Initial state (`baseUrl`, `providerId`) consumed by that bundle via
 *     `loadState('ihub_chat', …)`.
 *
 * @implements IEventListener<LoadAdditionalScriptsEvent>
 */
class LoadScriptsListener implements IEventListener {
    public function __construct(
        private readonly IConfig $config,
        private readonly IInitialState $initialState,
    ) {
    }

    public function handle(Event $event): void {
        if (!$event instanceof LoadAdditionalScriptsEvent) {
            return;
        }

        $baseUrl = $this->config->getAppValue(Application::APP_ID, 'ihub_base_url', '');
        $providerId = $this->config->getAppValue(
            Application::APP_ID,
            'ihub_provider_id',
            'nextcloud-main',
        );

        $this->initialState->provideInitialState('baseUrl', rtrim($baseUrl, '/'));
        $this->initialState->provideInitialState('providerId', $providerId);

        Util::addScript(Application::APP_ID, Application::APP_ID . '-files-init');
    }
}
