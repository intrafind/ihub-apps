# iHub Chat — Nextcloud app build script.
#
# This skeleton does not bundle or transpile JS — `src/main.js` is shipped
# as-is and loaded via Nextcloud's `script()` helper. `make build` simply
# copies the source into the `js/` directory the Nextcloud template loader
# expects.

APP_NAME = ihub_chat
SRC = src/main.js
DEST = js/main.js

.PHONY: build clean package help

help:
	@echo "Targets:"
	@echo "  build    Copy source assets into the locations Nextcloud expects."
	@echo "  clean    Remove built artefacts."
	@echo "  package  Build + tar a release archive at ../$(APP_NAME).tar.gz"

build:
	@mkdir -p js
	@cp $(SRC) $(DEST)
	@echo "Built $(DEST)"

clean:
	@rm -rf js
	@echo "Cleaned js/"

package: build
	@cd .. && tar --exclude='.git' --exclude='node_modules' -czf $(APP_NAME).tar.gz nextcloud-app
	@echo "Packaged ../$(APP_NAME).tar.gz"
