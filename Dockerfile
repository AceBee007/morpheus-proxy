# --- build the proxy (TypeScript -> dist/) ---
FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- build the React admin UI (-> ui/dist/) ---
FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS ui
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# --- runtime ---
FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=ui /app/ui/dist ./ui/dist
COPY config ./config

# Run unprivileged. Only the default log dir must be writable by that user;
# deployments that log elsewhere (e.g. /tmp) work with any uid.
RUN mkdir -p logs && chown node:node logs
USER node

# admin (18081), http proxy (18080), grpc proxy (15051) by default
EXPOSE 18080 18081 15051
CMD ["node", "dist/index.js"]
