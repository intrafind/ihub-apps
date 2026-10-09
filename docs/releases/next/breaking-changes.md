# Breaking Changes — Unreleased

## Playwright and Selenium Screenshot Tools Removed

The `playwrightScreenshot` and `seleniumScreenshot` tools are no longer shipped. No default app
used them, and they could not run on a default installation: Playwright needs a separately
installed browser and Selenium a Chrome driver, which the product never provided.

- The upgrade deletes the two tool files from `contents/tools/`. Apps that still list either tool
  keep working; the missing tool is skipped.
- The `playwright` and `selenium-webdriver` packages are no longer installed with the server.

**Before upgrading:** If an app of yours relies on one of these tools, keep a copy of its tool file
and script from the previous release before upgrading.
