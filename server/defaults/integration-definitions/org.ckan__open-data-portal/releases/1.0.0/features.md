# CKAN Open Data Portal 1.0.0

- First version. One installation per portal: GovData, the German state and city portals, data.gov, open.canada.ca, internal CKAN catalogs.
- Twelve actions over the CKAN Action API: search datasets, read a dataset or a resource, search resources, list organizations, groups and tags, read an organization, describe and query the DataStore (rows, and read-only SQL where the portal allows it), portal status. The resource-heavy and rarely needed ones are off by default.
- Install fields: portal URL, API path, token header and API token for private datasets, a default filter that is always added to searches, private datasets, SQL queries, a row cap the model cannot raise, and the metadata profile.
- Publishers (organizations) are offered as a scope the user picks per chat; every dataset in an answer is cited with a link to its portal page.
