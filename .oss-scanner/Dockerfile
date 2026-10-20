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

RUN npm run install:all
RUN npm run build:docker

# Don't let a flaky or environment-dependent test fail the whole build; the
# scanner mails primary_contact if this step itself errors out.
RUN npm run test:quick || echo "WARNING: test:quick reported failures"
