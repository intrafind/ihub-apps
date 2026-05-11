<?php
declare(strict_types=1);

namespace OCA\IhubChat\AppInfo;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\IhubChat\Listener\LoadScriptsListener;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

class Application extends App implements IBootstrap {
    public const APP_ID = 'ihub_chat';

    public function __construct(array $urlParams = []) {
        parent::__construct(self::APP_ID, $urlParams);
    }

    public function register(IRegistrationContext $context): void {
        // Inject the Files-page bundle (`js/ihub_chat-files-init.mjs`) plus
        // its initial-state payload whenever Nextcloud renders the Files app.
        $context->registerEventListener(
            LoadAdditionalScriptsEvent::class,
            LoadScriptsListener::class,
        );
    }

    public function boot(IBootContext $context): void {
    }
}
