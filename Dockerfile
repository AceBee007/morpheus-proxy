# --- build the proxy (TypeScript -> dist/) ---
FROM node:24.16.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- build the React admin UI (-> ui/dist/) ---
FROM node:24.16.0-alpine AS ui
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# --- runtime ---
FROM node:24.16.0-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=ui /app/ui/dist ./ui/dist
COPY config ./config

# admin (18081), http proxy (18080), grpc proxy (15051) by default
EXPOSE 18080 18081 15051
CMD ["node", "dist/index.js"]
