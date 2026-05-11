<?php
/**
 * iHub Chat — host page for the iHub iframe.
 *
 * Receives $_ (template vars) from PageController::index().
 */
script('ihub_chat', 'main');
style('ihub_chat', 'main');
?>
<div id="ihub-chat-root"
     class="ihub-chat-root"
     data-ihub-base-url="<?php p($_['ihubBaseUrl']); ?>"
     data-ihub-provider-id="<?php p($_['ihubProviderId']); ?>">
    <?php if (empty($_['ihubBaseUrl'])): ?>
        <div class="ihub-chat-config-missing">
            <h2><?php p($l->t('iHub Chat is not configured')); ?></h2>
            <p>
                <?php p($l->t('Ask your Nextcloud administrator to set the iHub base URL with:')); ?>
                <code>occ config:app:set ihub_chat ihub_base_url --value=https://ihub.example.com</code>
            </p>
        </div>
    <?php endif; ?>
</div>
