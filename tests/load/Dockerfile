# Load test runner + stubs image (no dependencies beyond Node).
#   docker build -t <registry>/ihub-loadtest:latest tests/load
FROM node:22-alpine
WORKDIR /loadtest
COPY . .
RUN rm -rf results && mkdir results && chown node:node results
USER node
ENTRYPOINT ["node"]
CMD ["run.mjs"]
