# AI Hub Apps container image
# Stage 1: build the application
FROM node:22-bullseye AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY contents ./contents
COPY docs ./docs
RUN cd client && npm install && cd .. && cd server && npm install && cd .. \
    && npm run prod:build

# Stage 2: create the runtime image
FROM node:22-bullseye
WORKDIR /app
COPY --from=build /app/dist /app
ENV NODE_ENV=production \
    APP_ROOT_DIR=/app \
    CONTENTS_DIR=contents
EXPOSE 3000
CMD ["node", "server/start-prod.js"]
