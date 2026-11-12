# Load test runner + stubs image (no dependencies beyond Node).
# Generate the document corpus first, so the image carries it:
#   npm run loadtest:corpus
#   docker build -t <registry>/ihub-loadtest:latest tests/load
FROM node:22-alpine
WORKDIR /loadtest
# Named paths only: nothing else from the build context ends up in the image.
COPY run.mjs setup.mjs report.mjs teardown.mjs ./
COPY lib ./lib
COPY scenarios ./scenarios
COPY profiles ./profiles
COPY stub ./stub
COPY tools ./tools
# The generated corpus, if `npm run loadtest:corpus` ran before the build.
COPY fixtures ./fixtures
RUN rm -rf results && mkdir results && chown node:node results
USER node
ENTRYPOINT ["node"]
CMD ["run.mjs"]
