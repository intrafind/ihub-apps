<?php
/**
 * iHub Chat — host page for the iHub iframe.
 *
 * Receives $_ (template vars) from PageController::index().
 * The JS bundle reads baseUrl/providerId via loadState (provided by
 * PageController), so no data-* attributes are needed here.
 */
script('ihub_chat', 'ihub_chat-main');
style('ihub_chat', 'main');
?>
<div id="ihub-chat-root" class="ihub-chat-root">
    <?php if (empty($_['baseUrlConfigured'])): ?>
        <div class="ihub-chat-config-missing">
            <h2><?php p($l->t('iHub Chat is not configured')); ?></h2>
            <p>
                <?php p($l->t('Ask your Nextcloud administrator to set the iHub base URL with:')); ?>
                <code>occ config:app:set ihub_chat ihub_base_url --value=https://ihub.example.com</code>
            </p>
        </div>
    <?php endif; ?>
</div>
