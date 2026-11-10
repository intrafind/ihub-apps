# Website Corpus 1.0.0

First version. Measures how many tokens a website holds and whether all of it fits into one context window.

- Five actions: find a site's pages (sitemap), outline a few pages to find boilerplate, crawl the pages in resumable batches, show the kept text of a page, and report the size.
- The report gives tokens per section, the number of 128k, 256k and 1M windows the corpus fills (all pages, after removing repeated lines, and without blog and news sections), the largest pages, exact and near-duplicate pages, how much of the sitemap was crawled, and the method.
- Only pages of the site itself are fetched, the site's robots.txt is honored, and requests are limited to a few per second across all workers.
- A crawl belongs to the user who started it and is removed after 14 days; one user keeps at most five.
- Setting: the most pages one corpus may have (default 3,000).
- Internal websites: the server's SSRF guard refuses private and internal addresses. A user whose crawl was refused can ask an admin to allow the host (the sixth action); the admin approves or declines under Admin → Integrations → Requests, and an approval covers only this integration. Alternatively the setting **Allow company-internal websites** lets every crawl reach the company network; loopback, link-local and cloud metadata addresses stay blocked in both cases.
