<?php
/**
 * iHub Chat — Nextcloud app routes.
 *
 * Only one route today: the iframe host page. The Nextcloud-side
 * frontend bundle registers a Files plugin action that opens this
 * route with the selected file paths in the URL hash.
 */
return [
    'routes' => [
        ['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],
    ],
];
