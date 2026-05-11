# iHub Chat — Nextcloud app build script.
#
# `npm run build` (via Vite + @nextcloud/vite-config) compiles src/*.ts
# into the `js/` directory Nextcloud loads via `Util::addScript` and
# `script()` in the template.

APP_NAME = ihub_chat
# Stage directory used by `package` so the tarball's top-level entry is the
# Nextcloud app id (`ihub_chat/`), not the repo's source dir name
# (`nextcloud-app/`). Nextcloud refuses to load an app whose directory name
# doesn't match the id in info.xml, so admins extracting the tarball into
# `custom_apps/` must end up with `custom_apps/ihub_chat/` directly.
STAGE_DIR ?= /tmp/$(APP_NAME)-pkg

.PHONY: build install clean package help

help:
	@echo "Targets:"
	@echo "  install  npm ci (install build/runtime deps)"
	@echo "  build    Compile TypeScript sources to js/ via Vite."
	@echo "  clean    Remove built artefacts (js/, node_modules/)."
	@echo "  package  Build + tar a release archive at ../$(APP_NAME).tar.gz"

install:
	npm ci

build: install
	npm run build

clean:
	rm -rf js node_modules
	@echo "Cleaned js/ and node_modules/."

# Portable packager (works with both GNU tar on Linux and bsdtar on macOS).
# Copies the source tree into a staging dir renamed to the Nextcloud app id,
# strips files that are only useful for development (sources, build config,
# node_modules), then tars from the staging parent so the archive's top
# level is `ihub_chat/`. Re-runnable.
package: build
	@rm -rf "$(STAGE_DIR)"
	@mkdir -p "$(STAGE_DIR)/$(APP_NAME)"
	@cp -R appinfo css img js lib templates "$(STAGE_DIR)/$(APP_NAME)/"
	@cp README.md "$(STAGE_DIR)/$(APP_NAME)/" 2>/dev/null || true
	@cp package.json "$(STAGE_DIR)/$(APP_NAME)/" 2>/dev/null || true
	@tar -czf ../$(APP_NAME).tar.gz -C "$(STAGE_DIR)" "$(APP_NAME)"
	@rm -rf "$(STAGE_DIR)"
	@echo "Packaged ../$(APP_NAME).tar.gz (top-level dir: $(APP_NAME)/)"
