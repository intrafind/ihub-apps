// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V213 — hosted MCP definitions move to the marketplace
 *
 * 29 definitions of hosted MCP servers (`mcp/<name>`: GitHub, Linear,
 * Stripe, Zapier, …) no longer ship in `server/defaults/integration-definitions/`;
 * they are integration items of the iHub Official Marketplace
 * (`integrations/mcp__<name>/` in intrafind/ihub-marketplace), where they are
 * updated without an iHub release. Admin → Integrations → Catalog lists them
 * from the marketplace and installs them from there.
 *
 * An installation of one of them would lose its definition on upgrade. For
 * every definition an installation in `config/integrations.json` uses, this
 * migration writes the marketplace's 1.0.0 copy (the shipped definition
 * without `builtIn`, plus its first release entry) to
 * `contents/integration-definitions/mcp__<name>/integration.json` and records
 * it in `config/installations.json` as installed from `ihub-official`, so the
 * installation keeps working, its tool ids stay the same, and later versions
 * arrive as marketplace updates. When the `ihub-official` registry is not
 * configured, the copy is written without a record: a local definition the
 * admin maintains.
 *
 * Re-linking: a server converted by V193 on an upgrade from 5.6.x became an
 * installation of the generic `com.intrafind/mcp-server` definition, because
 * V193 matches against the definitions shipped at the time it runs and these
 * no longer ship. So does a server an admin added by hand. Such an
 * installation is moved to the matching `mcp/<name>` definition when that
 * yields exactly the connection it has: the same endpoint (V193's URL
 * comparison: trimmed, trailing `/` ignored, case-insensitive) and
 * transport, the same headers (a definition's fixed header, such as Close's
 * `Close-Scope`, must already be among them), a sign-in mode the definition
 * offers with the same scheme (bearer, or the same header name and prefix),
 * the default tool prefix, MCP App views on, and no reconnect or other
 * setting the definition has no field for. The id, label, credential
 * reference, enabled state, action policy and app bindings stay as they are,
 * so the tool ids do not change; the timeout moves from the values onto the
 * installation, as V193 does for a matched server. An installation that does
 * not qualify stays generic and the log says why.
 *
 * A definition folder that already exists (installed from a registry or by
 * hand) is left as it is, and so is an existing record; a generic
 * installation is re-linked to it only when it holds the snapshot's version. Definitions no
 * installation uses are not written; the catalog offers them from the
 * marketplace. Idempotent: a second run finds the folders and changes
 * nothing.
 *
 * The definitions are a snapshot inlined below. Do NOT replace them with a
 * read of the marketplace or of `server/defaults/` — migrations must be
 * self-contained.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const version = '213';
export const description = 'mcp_definitions_to_marketplace';

const INTEGRATIONS_FILE = 'config/integrations.json';
const INSTALLATIONS_FILE = 'config/installations.json';
const REGISTRIES_FILE = 'config/registries.json';
const DEFINITIONS_DIR = 'integration-definitions';
const REGISTRY_ID = 'ihub-official';
const INSTALLED_BY = 'migration V213';
const GENERIC_DEFINITION = 'com.intrafind/mcp-server';
/** The cap of an installation's own timeout (snapshot of V193's MAX_INSTANCE_TIMEOUT_MS). */
const MAX_INSTANCE_TIMEOUT_MS = 120000;
/** The generic definition's reconnect defaults (snapshot as of V213). */
const RECONNECT_DEFAULTS = {
  reconnectEnabled: true,
  reconnectMaxRetries: 5,
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  reconnectGrowthFactor: 1.5
};

/** Folder name → the marketplace's 1.0.0 definition (snapshot of 2026-11-03). */
export const MOVED_DEFINITIONS = Object.freeze({
  mcp__apify: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/apify',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Apify',
      de: 'Apify'
    },
    description: {
      en: 'Run Apify Actors for web scraping, crawling and data extraction.\n\nAppend ?tools=actors,docs,apify/rag-web-browser (for example) to choose the tools and Actors.',
      de: 'Apify-Actors für Web-Scraping, Crawling und Datenextraktion ausführen.\n\nMit ?tools=actors,docs,apify/rag-web-browser (Beispiel) an der URL die Tools und Actors auswählen.'
    },
    publisher: {
      name: 'Apify'
    },
    categories: ['mcp', 'automation'],
    docsUrl: 'https://docs.apify.com/integrations/mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.apify.com'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Copy your API token from the Apify Console under Settings → API & Integrations.',
          de: 'API-Token in der Apify Console unter Settings → API & Integrations kopieren.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['scraping', 'crawler', 'web data']
    }
  },
  'mcp__astro-docs': {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/astro-docs',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Astro Docs',
      de: 'Astro Docs'
    },
    description: {
      en: 'Search the official documentation of the Astro web framework.',
      de: 'Die offizielle Dokumentation des Web-Frameworks Astro durchsuchen.'
    },
    publisher: {
      name: 'Astro'
    },
    categories: ['mcp', 'documentation'],
    docsUrl: 'https://docs.astro.build/en/guides/build-with-ai/',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.docs.astro.build/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['none']
    },
    install: [
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['web', 'framework', 'docs']
    }
  },
  mcp__braintrust: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/braintrust',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Braintrust',
      de: 'Braintrust'
    },
    description: {
      en: 'Search Braintrust experiments, datasets and logs for evaluating AI applications.\n\nThe EU region uses https://api-eu.braintrust.dev/mcp.',
      de: 'Braintrust-Experimente, Datasets und Logs zur Evaluierung von KI-Anwendungen durchsuchen.\n\nDie EU-Region nutzt https://api-eu.braintrust.dev/mcp.'
    },
    publisher: {
      name: 'Braintrust'
    },
    categories: ['mcp', 'development'],
    docsUrl: 'https://www.braintrust.dev/docs/reference/mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://api.braintrust.dev/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API key in Braintrust under Settings → API keys; the server acts with its owner’s permissions.',
          de: 'API-Schlüssel in Braintrust unter Settings → API keys erstellen; der Server handelt mit den Rechten des Besitzers.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['evals', 'llm', 'observability']
    }
  },
  'mcp__browser-use': {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/browser-use',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Browser Use',
      de: 'Browser Use'
    },
    description: {
      en: 'Let a cloud browser agent navigate websites, fill in forms and extract information.',
      de: 'Einen Cloud-Browser-Agenten Websites bedienen, Formulare ausfüllen und Informationen auslesen lassen.'
    },
    publisher: {
      name: 'Browser Use'
    },
    categories: ['mcp', 'automation'],
    docsUrl: 'https://docs.browser-use.com/cloud/guides/mcp-server',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://api.browser-use.com/v3/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'header',
        field: 'apiKey',
        header: 'X-Browser-Use-API-Key'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API key at cloud.browser-use.com under Settings → API keys. Usage is billed by Browser Use.',
          de: 'API-Schlüssel auf cloud.browser-use.com unter Settings → API keys erstellen. Die Nutzung wird von Browser Use abgerechnet.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['browser', 'web automation', 'agent']
    }
  },
  mcp__buildkite: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/buildkite',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Buildkite',
      de: 'Buildkite'
    },
    description: {
      en: 'Inspect Buildkite pipelines, builds, jobs and logs.\n\nTokens only work on the /direct endpoint. Add the header “X-Buildkite-Readonly: true” to hide tools that change data.',
      de: 'Buildkite-Pipelines, Builds, Jobs und Logs einsehen.\n\nTokens funktionieren nur am Endpunkt /direct. Mit dem Header „X-Buildkite-Readonly: true“ werden Tools ausgeblendet, die Daten ändern.'
    },
    publisher: {
      name: 'Buildkite'
    },
    categories: ['mcp', 'development'],
    docsUrl: 'https://buildkite.com/docs/apis/mcp-server/remote/configuring-ai-tools',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.buildkite.com/direct'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API access token under Personal Settings → API Access Tokens; its REST scopes decide which tools work.',
          de: 'API Access Token unter Personal Settings → API Access Tokens erstellen; seine REST-Scopes bestimmen, welche Tools funktionieren.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['ci', 'cd', 'pipelines', 'builds']
    }
  },
  mcp__close: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/close',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Close',
      de: 'Close'
    },
    description: {
      en: 'Search and update leads, contacts, opportunities and activities in the Close CRM.\n\nThe Close-Scope header starts read-only (mcp.read). Change it to mcp.write_safe or mcp.write_destructive to allow changes.',
      de: 'Leads, Kontakte, Opportunities und Aktivitäten im Close-CRM suchen und bearbeiten.\n\nDer Header Close-Scope ist zunächst nur lesend (mcp.read). Für Änderungen auf mcp.write_safe oder mcp.write_destructive setzen.'
    },
    publisher: {
      name: 'Close'
    },
    categories: ['mcp', 'customer'],
    docsUrl: 'https://developer.close.com/mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.close.com/mcp',
        headers: {
          'Close-Scope': 'mcp.read'
        }
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'header',
        field: 'apiKey',
        header: 'Close-API-Key'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API key in Close under Settings → Developer → API Keys. Each key belongs to one user.',
          de: 'API-Schlüssel in Close unter Settings → Developer → API Keys erstellen. Jeder Schlüssel gehört zu einem Benutzer.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['crm', 'sales', 'leads']
    }
  },
  mcp__cloudflare: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/cloudflare',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Cloudflare',
      de: 'Cloudflare'
    },
    description: {
      en: 'Manage a Cloudflare account through the Cloudflare API: Workers, DNS, R2, KV and more.',
      de: 'Ein Cloudflare-Konto über die Cloudflare-API verwalten: Workers, DNS, R2, KV und mehr.'
    },
    publisher: {
      name: 'Cloudflare'
    },
    categories: ['mcp', 'development'],
    docsUrl:
      'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.cloudflare.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API token at dash.cloudflare.com/profile/api-tokens with only the permissions needed. Tokens with IP filtering are not supported.',
          de: 'API-Token unter dash.cloudflare.com/profile/api-tokens mit nur den nötigen Berechtigungen erstellen. Tokens mit IP-Filter werden nicht unterstützt.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['workers', 'dns', 'r2', 'cdn']
    }
  },
  mcp__cloudinary: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/cloudinary',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Cloudinary',
      de: 'Cloudinary'
    },
    description: {
      en: 'Search, upload, tag and transform images and videos in Cloudinary.',
      de: 'Bilder und Videos in Cloudinary suchen, hochladen, verschlagworten und transformieren.'
    },
    publisher: {
      name: 'Cloudinary'
    },
    categories: ['mcp', 'content'],
    docsUrl: 'https://cloudinary.com/documentation/cloudinary_llm_mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://asset-management.mcp.cloudinary.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'header',
        field: 'apiKey',
        header: 'cloudinary-url'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Store the environment URL cloudinary://<api_key>:<api_secret>@<cloud_name> from Console → Settings → API Keys.',
          de: 'Die Umgebungs-URL cloudinary://<api_key>:<api_secret>@<cloud_name> aus Console → Settings → API Keys speichern.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['images', 'video', 'assets', 'dam']
    }
  },
  mcp__fireflies: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/fireflies',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Fireflies.ai',
      de: 'Fireflies.ai'
    },
    description: {
      en: 'Search meeting transcripts, summaries and action items recorded by Fireflies.',
      de: 'Von Fireflies aufgezeichnete Meeting-Transkripte, Zusammenfassungen und Aufgaben durchsuchen.'
    },
    publisher: {
      name: 'Fireflies.ai'
    },
    categories: ['mcp', 'customer'],
    docsUrl: 'https://docs.fireflies.ai/getting-started/mcp-configuration',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://api.fireflies.ai/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API key in Fireflies under Settings → Developer Settings. It acts with that user’s permissions.',
          de: 'API-Schlüssel in Fireflies unter Settings → Developer Settings erstellen. Er handelt mit den Rechten dieses Benutzers.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['meetings', 'transcripts', 'notes']
    }
  },
  mcp__github: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/github',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'GitHub',
      de: 'GitHub'
    },
    description: {
      en: 'Work with repositories, issues, pull requests, code search and Actions.\n\nUse https://api.githubcopilot.com/mcp/readonly for read-only tools. GitHub Enterprise Cloud with data residency uses https://copilot-api.<subdomain>.ghe.com/mcp; GitHub Enterprise Server is not supported.',
      de: 'Mit Repositories, Issues, Pull Requests, Codesuche und Actions arbeiten.\n\nMit https://api.githubcopilot.com/mcp/readonly nur lesende Tools nutzen. GitHub Enterprise Cloud mit Datenresidenz nutzt https://copilot-api.<subdomain>.ghe.com/mcp; GitHub Enterprise Server wird nicht unterstützt.'
    },
    publisher: {
      name: 'GitHub'
    },
    categories: ['mcp', 'development'],
    docsUrl:
      'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://api.githubcopilot.com/mcp/'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create a personal access token under GitHub Settings → Developer settings → Personal access tokens, with the scopes the tools need (for example repo, read:org).',
          de: 'Persönliches Zugriffstoken unter GitHub Settings → Developer settings → Personal access tokens erstellen, mit den Scopes, die die Tools brauchen (z. B. repo, read:org).'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['git', 'code', 'issues', 'pull requests']
    }
  },
  'mcp__google-maps': {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/google-maps',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Google Maps',
      de: 'Google Maps'
    },
    description: {
      en: 'Ground answers in Google Maps data: places, addresses and routes (Maps Grounding Lite).',
      de: 'Antworten mit Google-Maps-Daten untermauern: Orte, Adressen und Routen (Maps Grounding Lite).'
    },
    publisher: {
      name: 'Google'
    },
    categories: ['mcp', 'data'],
    docsUrl: 'https://developers.google.com/maps/ai/grounding-lite',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mapstools.googleapis.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'header',
        field: 'apiKey',
        header: 'X-Goog-Api-Key'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Enable the “Maps Grounding Lite API” in a Google Cloud project and create an API key under APIs & Services → Credentials. Requests are billed per call.',
          de: 'Die „Maps Grounding Lite API“ in einem Google-Cloud-Projekt aktivieren und unter APIs & Services → Credentials einen API-Schlüssel erstellen. Anfragen werden pro Aufruf abgerechnet.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['maps', 'places', 'geocoding', 'routes', 'location']
    }
  },
  mcp__honeycomb: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/honeycomb',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Honeycomb',
      de: 'Honeycomb'
    },
    description: {
      en: 'Query observability data, traces, boards, triggers and SLOs in Honeycomb.\n\nEU teams use https://mcp.eu1.honeycomb.io/mcp.',
      de: 'Observability-Daten, Traces, Boards, Trigger und SLOs in Honeycomb abfragen.\n\nEU-Teams nutzen https://mcp.eu1.honeycomb.io/mcp.'
    },
    publisher: {
      name: 'Honeycomb'
    },
    categories: ['mcp', 'development'],
    docsUrl: 'https://docs.honeycomb.io/integrations/mcp/configuration-guide',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.honeycomb.io/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'A team owner creates a Management API key (Team Settings → API Keys) with the Model Context Protocol and Environments permissions. Store it as <KEY_ID>:<KEY_SECRET>.',
          de: 'Ein Team-Owner erstellt einen Management-API-Schlüssel (Team Settings → API Keys) mit den Berechtigungen Model Context Protocol und Environments. Als <KEY_ID>:<KEY_SECRET> speichern.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['observability', 'tracing', 'slo']
    }
  },
  'mcp__hugging-face': {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/hugging-face',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Hugging Face',
      de: 'Hugging Face'
    },
    description: {
      en: 'Search models, datasets, Spaces and papers on the Hugging Face Hub.\n\nWorks without a token with a reduced tool set. For all tools, create an access token at huggingface.co/settings/tokens, switch the authentication to Bearer token, and pick tools and Spaces at huggingface.co/settings/mcp.',
      de: 'Modelle, Datasets, Spaces und Paper auf dem Hugging Face Hub durchsuchen.\n\nFunktioniert ohne Token mit weniger Tools. Für alle Tools ein Access Token unter huggingface.co/settings/tokens erstellen, die Authentifizierung auf Bearer-Token umstellen und Tools sowie Spaces unter huggingface.co/settings/mcp auswählen.'
    },
    publisher: {
      name: 'Hugging Face'
    },
    categories: ['mcp', 'data'],
    docsUrl: 'https://huggingface.co/docs/hub/hf-mcp-server',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://huggingface.co/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['none']
    },
    install: [
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['models', 'datasets', 'ml', 'papers']
    }
  },
  mcp__intercom: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/intercom',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Intercom',
      de: 'Intercom'
    },
    description: {
      en: 'Search conversations, contacts, companies and help-center articles, and add internal notes.\n\nEU-hosted workspaces use https://mcp.eu.intercom.com/mcp. Australian workspaces are not supported.',
      de: 'Konversationen, Kontakte, Firmen und Help-Center-Artikel durchsuchen und interne Notizen hinzufügen.\n\nIn der EU gehostete Workspaces nutzen https://mcp.eu.intercom.com/mcp. Australische Workspaces werden nicht unterstützt.'
    },
    publisher: {
      name: 'Intercom'
    },
    categories: ['mcp', 'customer'],
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.intercom.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Use the access token of an Intercom app: Developer Hub → your app → Configure → Authentication.',
          de: 'Access Token einer Intercom-App verwenden: Developer Hub → App → Configure → Authentication.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['support', 'helpdesk', 'crm']
    }
  },
  mcp__linear: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/linear',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Linear',
      de: 'Linear'
    },
    description: {
      en: 'Find, create and update Linear issues, projects and comments.',
      de: 'Linear-Issues, Projekte und Kommentare finden, erstellen und bearbeiten.'
    },
    publisher: {
      name: 'Linear'
    },
    categories: ['mcp', 'productivity'],
    docsUrl: 'https://linear.app/docs/mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.linear.app/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create a personal API key in Linear under Settings → Account → Security & Access. A key with read permission only gives read-only access.',
          de: 'Persönlichen API-Schlüssel in Linear unter Settings → Account → Security & Access erstellen. Ein Schlüssel nur mit Leserecht erlaubt nur lesenden Zugriff.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['issues', 'project management', 'tickets']
    }
  },
  'mcp__microsoft-learn': {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/microsoft-learn',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Microsoft Learn',
      de: 'Microsoft Learn'
    },
    description: {
      en: 'Search and read official Microsoft documentation and code samples for Azure, Microsoft 365, .NET and more.',
      de: 'Offizielle Microsoft-Dokumentation und Codebeispiele zu Azure, Microsoft 365, .NET und mehr durchsuchen und lesen.'
    },
    publisher: {
      name: 'Microsoft'
    },
    categories: ['mcp', 'documentation'],
    docsUrl: 'https://learn.microsoft.com/en-us/training/support/mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://learn.microsoft.com/api/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['none']
    },
    install: [
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['azure', 'microsoft 365', '.net', 'docs']
    }
  },
  mcp__modjo: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/modjo',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Modjo',
      de: 'Modjo'
    },
    description: {
      en: 'Analyse recorded sales calls, deals and accounts.',
      de: 'Aufgezeichnete Verkaufsgespräche, Deals und Accounts analysieren.'
    },
    publisher: {
      name: 'Modjo'
    },
    categories: ['mcp', 'customer'],
    docsUrl: 'https://help.modjo.ai/en/articles/15459539-set-up-and-use-the-modjo-mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://api.mcp.modjo.ai/v1/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'An administrator creates the key in Modjo under Settings → Integrations → Modjo API key. It covers the whole workspace.',
          de: 'Ein Administrator erstellt den Schlüssel in Modjo unter Settings → Integrations → Modjo API key. Er gilt für den gesamten Workspace.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['sales', 'calls', 'conversation intelligence']
    }
  },
  mcp__monday: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/monday',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'monday.com',
      de: 'monday.com'
    },
    description: {
      en: 'Read and update monday.com boards, items, updates and workspaces.',
      de: 'monday.com-Boards, Items, Updates und Workspaces lesen und bearbeiten.'
    },
    publisher: {
      name: 'monday.com'
    },
    categories: ['mcp', 'productivity'],
    docsUrl: 'https://developer.monday.com/api-reference/docs/mcp-api-token',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.monday.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create a personal API token via your profile picture → Developers → My access tokens. It acts with that user’s permissions.',
          de: 'Persönliches API-Token über das Profilbild → Developers → My access tokens erstellen. Es handelt mit den Rechten dieses Benutzers.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['project management', 'boards', 'tasks']
    }
  },
  mcp__neon: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/neon',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Neon',
      de: 'Neon'
    },
    description: {
      en: 'Manage serverless Postgres projects and branches on Neon and run SQL queries.\n\nAppend ?readonly=true for read-only tools, or ?projectId=<id> to limit the server to one project.',
      de: 'Serverlose Postgres-Projekte und -Branches auf Neon verwalten und SQL-Abfragen ausführen.\n\nMit ?readonly=true nur lesende Tools nutzen oder mit ?projectId=<id> auf ein Projekt beschränken.'
    },
    publisher: {
      name: 'Neon'
    },
    categories: ['mcp', 'development'],
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.neon.tech/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API key in the Neon Console under Settings → API keys.',
          de: 'API-Schlüssel in der Neon Console unter Settings → API keys erstellen.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['postgres', 'database', 'sql']
    }
  },
  mcp__pagerduty: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/pagerduty',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'PagerDuty',
      de: 'PagerDuty'
    },
    description: {
      en: 'Look up incidents, services, schedules and on-call rotations in PagerDuty.\n\nEU accounts use https://mcp.eu.pagerduty.com/mcp.',
      de: 'Incidents, Services, Dienstpläne und Rufbereitschaften in PagerDuty abrufen.\n\nEU-Konten nutzen https://mcp.eu.pagerduty.com/mcp.'
    },
    publisher: {
      name: 'PagerDuty'
    },
    categories: ['mcp', 'development'],
    docsUrl: 'https://support.pagerduty.com/main/docs/pagerduty-mcp-server-integration-guide',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.pagerduty.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'header',
        field: 'apiKey',
        header: 'Authorization',
        valuePrefix: 'Token token='
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Use a PagerDuty user API token (My Profile → User Settings) or an account API key (Integrations → API Access Keys).',
          de: 'PagerDuty-User-API-Token (My Profile → User Settings) oder Account-API-Schlüssel (Integrations → API Access Keys) verwenden.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['incidents', 'on-call', 'operations']
    }
  },
  mcp__posthog: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/posthog',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'PostHog',
      de: 'PostHog'
    },
    description: {
      en: 'Query product analytics, insights, feature flags, experiments and error tracking.\n\nEU Cloud projects use https://mcp-eu.posthog.com/mcp. Add ?features=flags,dashboards (for example) to the URL to limit the tools to those areas.',
      de: 'Produktanalysen, Insights, Feature Flags, Experimente und Fehler-Tracking abfragen.\n\nProjekte in der EU Cloud nutzen https://mcp-eu.posthog.com/mcp. Mit ?features=flags,dashboards (Beispiel) an der URL werden die Tools auf diese Bereiche beschränkt.'
    },
    publisher: {
      name: 'PostHog'
    },
    categories: ['mcp', 'analytics'],
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.posthog.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create a personal API key with the “MCP Server” preset under Settings → Personal API keys (keys start with phx_).',
          de: 'Persönlichen API-Schlüssel mit der Vorlage „MCP Server“ unter Settings → Personal API keys erstellen (beginnt mit phx_).'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['product analytics', 'feature flags', 'errors']
    }
  },
  mcp__postman: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/postman',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Postman',
      de: 'Postman'
    },
    description: {
      en: 'Manage Postman workspaces, collections, environments and API specifications.\n\n/minimal offers the essential tools; use /mcp for the full tool set or /code for code generation. The EU region uses https://mcp.eu.postman.com.',
      de: 'Postman-Workspaces, Collections, Umgebungen und API-Spezifikationen verwalten.\n\n/minimal bietet die wichtigsten Tools; /mcp für alle Tools oder /code für Codegenerierung verwenden. Die EU-Region nutzt https://mcp.eu.postman.com.'
    },
    publisher: {
      name: 'Postman'
    },
    categories: ['mcp', 'development'],
    docsUrl: 'https://learning.postman.com/docs/developer/postman-api/postman-mcp-server/',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.postman.com/minimal'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create a Postman API key under Settings → API keys (postman.postman.co/settings/me/api-keys).',
          de: 'Postman-API-Schlüssel unter Settings → API keys erstellen (postman.postman.co/settings/me/api-keys).'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['api', 'testing', 'collections']
    }
  },
  mcp__primamcp: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/primamcp',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'PRIMAMCP',
      de: 'PRIMAMCP'
    },
    description: {
      en: 'Look up German and EU legal information for legal research.',
      de: 'Rechtsinformationen zu deutschem und EU-Recht für die juristische Recherche abrufen.'
    },
    publisher: {
      name: 'PLANIT PRIMA'
    },
    categories: ['mcp', 'data'],
    docsUrl: 'https://mcp.planitprima.com/docs',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.planitprima.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API key (starts with sk-legal-) at mcp.planitprima.com/keys; it is shown only once. The free tier allows 150 requests per month.',
          de: 'API-Schlüssel (beginnt mit sk-legal-) unter mcp.planitprima.com/keys erstellen; er wird nur einmal angezeigt. Der kostenlose Tarif erlaubt 150 Anfragen pro Monat.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['legal', 'law', 'germany', 'eu', 'lawbster']
    }
  },
  mcp__statista: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/statista',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Statista',
      de: 'Statista'
    },
    description: {
      en: 'Search Statista statistics and retrieve chart data for market and consumer research.',
      de: 'Statista-Statistiken durchsuchen und Diagrammdaten für Markt- und Verbraucherforschung abrufen.'
    },
    publisher: {
      name: 'Statista'
    },
    categories: ['mcp', 'data'],
    docsUrl: 'https://docs.platform.statista.ai/mcp-server/introduction',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://api.statista.ai/v1/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'header',
        field: 'apiKey',
        header: 'x-api-key'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Statista issues the API key after you request access at platform.statista.ai; it requires a Statista contract.',
          de: 'Statista stellt den API-Schlüssel nach einer Zugangsanfrage auf platform.statista.ai aus; ein Statista-Vertrag ist erforderlich.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['statistics', 'market research']
    }
  },
  mcp__stripe: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/stripe',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Stripe',
      de: 'Stripe'
    },
    description: {
      en: 'Work with Stripe customers, payments, invoices, subscriptions and products, and search the Stripe docs.\n\nTest in a sandbox first. Stripe asks for human confirmation of some write actions, such as refunds.',
      de: 'Mit Stripe-Kunden, Zahlungen, Rechnungen, Abos und Produkten arbeiten und die Stripe-Dokumentation durchsuchen.\n\nZuerst in einer Sandbox testen. Für manche schreibenden Aktionen, etwa Erstattungen, verlangt Stripe eine Bestätigung durch einen Menschen.'
    },
    publisher: {
      name: 'Stripe'
    },
    categories: ['mcp', 'finance'],
    docsUrl: 'https://docs.stripe.com/mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.stripe.com'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an agent API key (Dashboard → API keys, shown with an “Agent” badge) with only the permissions needed. From 31 October 2026 Stripe MCP rejects secret keys and restricted keys without the Agent tag.',
          de: 'Agent-API-Schlüssel erstellen (Dashboard → API keys, mit „Agent“-Kennzeichnung) und nur die nötigen Berechtigungen vergeben. Ab 31. Oktober 2026 lehnt Stripe MCP Secret Keys und Restricted Keys ohne Agent-Kennzeichnung ab.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['payments', 'billing', 'subscriptions', 'invoices']
    }
  },
  mcp__supabase: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/supabase',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Supabase',
      de: 'Supabase'
    },
    description: {
      en: 'Query and manage Supabase projects: database, tables, migrations, edge functions and logs.\n\nRecommended: append ?project_ref=<project-ref>&read_only=true to limit the server to one project and read-only queries.',
      de: 'Supabase-Projekte abfragen und verwalten: Datenbank, Tabellen, Migrationen, Edge Functions und Logs.\n\nEmpfohlen: ?project_ref=<projekt-ref>&read_only=true an die URL anhängen, um den Server auf ein Projekt und lesende Abfragen zu beschränken.'
    },
    publisher: {
      name: 'Supabase'
    },
    categories: ['mcp', 'development'],
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.supabase.com/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create a personal access token in the Supabase dashboard under Account → Access Tokens (project API keys do not work).',
          de: 'Persönliches Zugriffstoken im Supabase-Dashboard unter Account → Access Tokens erstellen (Projekt-API-Schlüssel funktionieren nicht).'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['postgres', 'database', 'sql']
    }
  },
  mcp__superglue: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/superglue',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'superglue',
      de: 'superglue'
    },
    description: {
      en: 'Discover and run prebuilt integration tools that connect APIs and systems.',
      de: 'Vorgefertigte Integrationstools finden und ausführen, die APIs und Systeme verbinden.'
    },
    publisher: {
      name: 'superglue'
    },
    categories: ['mcp', 'automation'],
    docsUrl: 'https://superglue.ai/docs/mcp/using-the-mcp/',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://api.superglue.cloud/mcp'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API key at app.superglue.cloud via the organization menu → API Keys.',
          de: 'API-Schlüssel auf app.superglue.cloud über das Organisationsmenü → API Keys erstellen.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['integrations', 'api', 'workflows']
    }
  },
  mcp__wix: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/wix',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Wix',
      de: 'Wix'
    },
    description: {
      en: 'Manage Wix sites and the business data behind them.\n\nReplace YOUR_WIX_ACCOUNT_ID in the additional headers with your Wix account ID. The key is sent without a “Bearer” prefix.',
      de: 'Wix-Websites und die zugehörigen Geschäftsdaten verwalten.\n\nYOUR_WIX_ACCOUNT_ID in den zusätzlichen Headern durch die eigene Wix-Konto-ID ersetzen. Der Schlüssel wird ohne „Bearer“-Präfix gesendet.'
    },
    publisher: {
      name: 'Wix'
    },
    categories: ['mcp', 'content'],
    docsUrl: 'https://dev.wix.com/docs/overview/ai-the-wix-platform/the-wix-mcp',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.wix.com/mcp',
        headers: {
          'wix-account-id': 'YOUR_WIX_ACCOUNT_ID'
        }
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'header',
        field: 'apiKey',
        header: 'Authorization'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'Create an API key in the Wix API Keys Manager with the permissions the tools need.',
          de: 'API-Schlüssel im Wix API Keys Manager mit den nötigen Berechtigungen erstellen.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['website', 'cms', 'e-commerce']
    }
  },
  mcp__zapier: {
    $schema: 'https://ihub.intrafind.com/schemas/integration/v1.json',
    id: 'mcp/zapier',
    version: '1.0.0',
    compatibility: {
      ihub: '>=5.6.0'
    },
    releases: [
      {
        version: '1.0.0',
        date: '2026-11-03',
        summary: {
          en: 'First version in the marketplace; previously shipped with iHub.',
          de: 'Erste Version im Marketplace; bisher mit iHub ausgeliefert.'
        }
      }
    ],
    name: {
      en: 'Zapier',
      de: 'Zapier'
    },
    description: {
      en: 'Run actions in thousands of apps through the actions configured on a Zapier MCP server.',
      de: 'Aktionen in Tausenden Apps über die auf einem Zapier-MCP-Server konfigurierten Aktionen ausführen.'
    },
    publisher: {
      name: 'Zapier'
    },
    categories: ['mcp', 'automation'],
    docsUrl: 'https://docs.zapier.com/mcp/get-started/connect/openai-api',
    runs: 'cloud',
    protocol: {
      type: 'mcp',
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.zapier.com/api/v1/connect'
      },
      apps: {
        enabled: true
      }
    },
    auth: {
      modes: ['service-account'],
      serviceAccount: {
        kind: 'bearer',
        field: 'apiKey'
      }
    },
    install: [
      {
        key: 'apiKey',
        type: 'secret',
        title: {
          en: 'API key',
          de: 'API-Schlüssel'
        },
        description: {
          en: 'At mcp.zapier.com create a server, add the actions it may run, then generate a token on its Connect tab.',
          de: 'Auf mcp.zapier.com einen Server anlegen, die erlaubten Aktionen hinzufügen und im Tab „Connect“ ein Token erzeugen.'
        }
      },
      {
        key: 'headers',
        type: 'list',
        title: {
          en: 'Additional headers',
          de: 'Zusätzliche Header'
        },
        description: {
          en: 'Non-secret headers sent on every request, one per line as "Name: value". A header named here replaces the one the definition sets.',
          de: 'Nicht geheime Header, die mit jeder Anfrage gesendet werden, einer pro Zeile als „Name: Wert“. Ein hier genannter Header ersetzt den gleichnamigen der Definition.'
        },
        advanced: true
      }
    ],
    capabilities: ['tools', 'views'],
    _meta: {
      tags: ['workflows', 'integrations', 'no-code']
    }
  }
});

/** Definition id (`mcp/github`) → folder name (`mcp__github`). */
const FOLDER_BY_ID = new Map(
  Object.entries(MOVED_DEFINITIONS).map(([folder, definition]) => [definition.id, folder])
);

export async function precondition(ctx) {
  return await ctx.fileExists(INTEGRATIONS_FILE);
}

function writeText(ctx) {
  if (ctx.writeText) return ctx.writeText;
  return async (relPath, text) => {
    const target = path.join(ctx.contentsDir, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
  };
}

// Snapshot of V193's normalizeUrl. Do NOT replace with an import.
function normalizeUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '').toLowerCase() : '';
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

// Snapshot of parseHeaderLines (protocols/mcp/serverConfig.js) as of V213.
function parseHeaderLines(lines) {
  const out = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const idx = String(line).indexOf(':');
    if (idx <= 0) continue;
    const name = String(line).slice(0, idx).trim();
    if (name)
      out[name.toLowerCase()] = String(line)
        .slice(idx + 1)
        .trim();
  }
  return out;
}

function sameRecord(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * The moved definition a generic installation can be re-linked to, as
 * `{ folder, instance }` with the re-linked installation, or `{ reason }`
 * when its endpoint is a moved one but the connection would change, or null
 * when its endpoint is none of them.
 *
 * @param {object} inst - a `com.intrafind/mcp-server` installation
 * @returns {{ folder: string, instance: object } | { reason: string } | null}
 */
export function relinkFor(inst) {
  const values = inst.values && typeof inst.values === 'object' ? inst.values : {};
  const transport = values.transport || 'streamableHttp';
  const url = normalizeUrl(values.url);
  if (!url) return null;
  const entry = Object.entries(MOVED_DEFINITIONS).find(
    ([, def]) => normalizeUrl(def.protocol.transport.url) === url
  );
  if (!entry) return null;
  const [folder, def] = entry;
  const fixed = def.protocol.transport;
  if (transport !== fixed.type) return { reason: `transport "${transport}" is not ${fixed.type}` };

  const mode = inst.auth?.mode || 'none';
  if (!def.auth.modes.includes(mode)) {
    return { reason: `sign-in mode "${mode}" is not offered by ${def.id}` };
  }
  if (mode === 'service-account') {
    const account = def.auth.serviceAccount;
    const kind = values.authKind || 'bearer';
    if (kind !== account.kind) {
      return { reason: `the credential is sent as "${kind}", ${def.id} sends "${account.kind}"` };
    }
    if (kind === 'header') {
      const name = String(values.headerName || '').toLowerCase();
      const prefix = values.valuePrefix || '';
      if (name !== account.header.toLowerCase() || prefix !== (account.valuePrefix || '')) {
        return { reason: `the credential header differs from ${def.id}'s ${account.header}` };
      }
    }
  }

  const prefix = typeof values.toolPrefix === 'string' ? values.toolPrefix.trim() : '';
  if (prefix && prefix !== `${inst.id}__`) {
    return { reason: `custom toolPrefix "${prefix}" (${def.id} has no toolPrefix field)` };
  }
  if (values.appsEnabled === false) return { reason: 'MCP App views are switched off' };
  for (const [key, standard] of Object.entries(RECONNECT_DEFAULTS)) {
    if (!isEmpty(values[key]) && values[key] !== standard) {
      return { reason: `${key} is set (${def.id} has no reconnect fields)` };
    }
  }
  const carried = new Set([
    'transport',
    'url',
    'headers',
    'authKind',
    'headerName',
    'valuePrefix',
    'toolPrefix',
    'timeoutMs',
    'appsEnabled',
    ...Object.keys(RECONNECT_DEFAULTS)
  ]);
  const other = Object.keys(values).filter(key => !carried.has(key) && !isEmpty(values[key]));
  if (other.length) return { reason: `${other.join(', ')} set (${def.id} has no such field)` };

  // The definition's fixed headers, overridden by the admin's, must be
  // exactly the headers the installation sends now.
  const own = parseHeaderLines(values.headers);
  const fixedHeaders = Object.fromEntries(
    Object.entries(fixed.headers || {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  if (!sameRecord({ ...fixedHeaders, ...own }, own)) {
    const missing = Object.keys(fixedHeaders).filter(name => !(name in own));
    return { reason: `${def.id} would add the header(s) ${missing.join(', ')}` };
  }

  const timeout = Number(values.timeoutMs);
  const hasTimeout = !isEmpty(values.timeoutMs) && Number.isFinite(timeout) && timeout !== 30000;
  if (hasTimeout && timeout > MAX_INSTANCE_TIMEOUT_MS) {
    return {
      reason: `timeoutMs ${timeout} is above the ${MAX_INSTANCE_TIMEOUT_MS} an installation may set`
    };
  }

  const instance = {
    ...inst,
    definition: def.id,
    definitionVersion: def.version,
    values:
      Array.isArray(values.headers) && values.headers.length ? { headers: values.headers } : {}
  };
  if (hasTimeout) instance.timeoutMs = timeout;
  return { folder, instance };
}

/**
 * Re-link the generic installations that qualify (see {@link relinkFor}) in
 * place; logs each one, and each that matched an endpoint but stays generic.
 * @returns {Promise<boolean>} whether any installation changed
 */
async function relinkGeneric(ctx, installed) {
  let changed = false;
  for (let i = 0; i < installed.length; i++) {
    const inst = installed[i];
    if (inst?.definition !== GENERIC_DEFINITION) continue;
    const result = relinkFor(inst);
    if (!result) continue;
    if (result.reason) {
      ctx.log(`${inst.id}: stays an installation of ${GENERIC_DEFINITION}: ${result.reason}`);
      continue;
    }
    const def = MOVED_DEFINITIONS[result.folder];
    const rel = `${DEFINITIONS_DIR}/${result.folder}/integration.json`;
    if (await ctx.fileExists(rel)) {
      let existing = null;
      try {
        existing = await ctx.readJson(rel);
      } catch {
        existing = null;
      }
      if (existing?.version !== def.version) {
        ctx.log(
          `${inst.id}: stays an installation of ${GENERIC_DEFINITION}: ${rel} holds version ${existing?.version ?? 'unknown'}, not ${def.version}`
        );
        continue;
      }
    }
    installed[i] = result.instance;
    changed = true;
    ctx.log(`${inst.id}: re-linked from ${GENERIC_DEFINITION} to ${def.id}`);
  }
  return changed;
}

export async function up(ctx) {
  const config = (await ctx.readJson(INTEGRATIONS_FILE)) || {};
  const installed = Array.isArray(config.installed) ? config.installed : [];
  if (await relinkGeneric(ctx, installed)) {
    await ctx.writeJson(INTEGRATIONS_FILE, { ...config, installed });
  }
  const used = new Map();
  for (const inst of installed) {
    const folder = FOLDER_BY_ID.get(inst?.definition);
    if (!folder) continue;
    if (!used.has(folder)) used.set(folder, []);
    used.get(folder).push(inst.id);
  }
  if (used.size === 0) {
    ctx.log('No installation uses a definition that moved to the marketplace');
    return;
  }

  const registries = (await ctx.fileExists(REGISTRIES_FILE))
    ? (await ctx.readJson(REGISTRIES_FILE)) || {}
    : {};
  const hasRegistry = (registries.registries || []).some(r => r?.id === REGISTRY_ID);
  const manifest = (await ctx.fileExists(INSTALLATIONS_FILE))
    ? (await ctx.readJson(INSTALLATIONS_FILE)) || {}
    : {};
  if (!manifest.installations || typeof manifest.installations !== 'object') {
    manifest.installations = {};
  }

  const write = writeText(ctx);
  const now = new Date().toISOString();
  let recorded = 0;
  for (const [folder, ids] of used) {
    const definition = MOVED_DEFINITIONS[folder];
    const rel = `${DEFINITIONS_DIR}/${folder}/integration.json`;
    if (await ctx.fileExists(rel)) {
      ctx.log(`${definition.id}: ${rel} exists already; left as it is (used by ${ids.join(', ')})`);
      continue;
    }
    await write(rel, `${JSON.stringify(definition, null, 2)}\n`);
    const key = `integration:${folder}`;
    if (hasRegistry && !manifest.installations[key]) {
      manifest.installations[key] = {
        type: 'integration',
        itemId: folder,
        registryId: REGISTRY_ID,
        version: definition.version,
        installedAt: now,
        installedBy: INSTALLED_BY,
        updatedAt: null,
        updateAvailable: null,
        sourceUrl: null
      };
      recorded++;
      ctx.log(`${definition.id}: installed from ${REGISTRY_ID} for ${ids.join(', ')}`);
    } else {
      ctx.warn(
        `${definition.id}: written as a local definition for ${ids.join(', ')}; ` +
          `the registry ${REGISTRY_ID} is not configured, so it gets no marketplace updates`
      );
    }
  }
  if (recorded > 0) await ctx.writeJson(INSTALLATIONS_FILE, manifest);
}
