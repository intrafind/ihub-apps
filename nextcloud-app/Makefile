# iHub Chat — Nextcloud app build script.
#
# `npm run build` (via Vite + @nextcloud/vite-config) compiles src/*.ts
# into the `js/` directory Nextcloud loads via `Util::addScript` and
# `script()` in the template.

APP_NAME = ihub_chat

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

package: build
	@cd .. && tar \
	  --exclude='.git' \
	  --exclude='node_modules' \
	  --exclude='src' \
	  --exclude='package-lock.json' \
	  --exclude='tsconfig.json' \
	  --exclude='vite.config.ts' \
	  -czf $(APP_NAME).tar.gz nextcloud-app
	@echo "Packaged ../$(APP_NAME).tar.gz"
