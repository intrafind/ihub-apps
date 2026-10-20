# Build image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# Installs dependencies, builds the full app, then runs the fast test suite so a
# broken checkout is caught here, while the build still has network access.
FROM node:24-alpine

RUN apk add --no-cache \
    curl \
    g++ \
    git \
    make \
    musl-dev \
    python3

COPY . /src
WORKDIR /src

# npm ci (not install:all's plain `npm install`) so the scanner tests exactly
# what the committed lockfiles pin, not whatever `npm install` freshly resolves.
# --ignore-scripts: this build has network access, so a compromised dependency's
# install script could exfiltrate during it; none of our deps need one to run
# (checked: the only two with postinstall/prepare hooks are a legacy-npm-only
# compatibility shim and a version-mismatch warning printer).
# test:quick is this repo's own required, blocking CI check, so it gates this
# build the same way: a failure here fails the image and mails primary_contact.
RUN npm ci --ignore-scripts && \
    npm ci --ignore-scripts --prefix client && \
    npm ci --ignore-scripts --prefix server && \
    npm run build:docker && \
    npm run test:quick
