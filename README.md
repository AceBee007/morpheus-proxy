# morpheus-proxy

A testing-environment proxy that transparently forwards HTTP and gRPC traffic
while letting you inspect, intercept, mock, and fault-inject requests and
responses. Rules are hot-loaded through an admin API / web UI — no restart.

See [docs/spec.md](docs/spec.md) for the full specification.

## Overview

- **Runtime**: Node.js 24 LTS + TypeScript, ESM (`moduleResolution: NodeNext`)
- **Data plane**: HTTP/1.1, HTTP/2 (h2c), gRPC unary + streaming
- **Control plane**: JSON admin API + React SPA on a dedicated admin port
- **Deployment model**: sits between a microservice and its istio sidecar;
  TLS/mTLS is terminated by istio, so morpheus only handles plaintext
- **Default behaviour**: transparent forwarding; rules apply only on a match

## Capabilities

- Regex / composite (`all` / `any` / `not`) / script matchers
- Request stage: `mock_response`, `fault`, `request_rewrite`, delay
- Response stage: `fault`, `response_replace` (header regex), `script_manipulator`, delay
- Consumable rules (`times`, `resetAfterMs`): apply N times, then fall through
- gRPC descriptor registry for message decode / mock / manipulation
- Traffic log with body capture, masking, retention, and SSE streaming
- Simulation of rules against stored logs or sample requests
- Import / export of rules (rules live in memory only)
- Script matchers / manipulators run in an isolated subprocess sandbox

## Develop

```sh
npm install
npm run check     # backend typecheck (tsc) + lint (eslint, type-checked)
npm run lint      # backend eslint only  (lint:fix to autofix)
npm run check:ui  # UI typecheck + lint
npm run check:all # backend + UI
npm test          # unit + integration tests (vitest)
npm run build     # compile the proxy to dist/
npm run build:ui  # build the React admin UI to ui/dist/
npm start         # run dist/index.js
```

Linting uses `typescript-eslint` with the type-checked ruleset (plus
`react-hooks` / `react-refresh` for the UI).

## Configuration

The app starts with built-in defaults even without a config file. A JSONC
config can be supplied via `--config <path>` or `MORPHEUS_CONFIG`, otherwise
`./morpheus.jsonc` is used if present. Invalid keys fall back to defaults with
a warning; the app never fails to start on config problems.

[config/default.jsonc](config/default.jsonc) documents every setting and is
kept identical to the hard-coded defaults (verified by a test).

Endpoints (default base path `/_morpheus`, admin port `18081`):

- `GET  /_morpheus/healthz/live` · `GET /_morpheus/healthz/ready`
- `*    /_morpheus/api/v1/rules…` — rule CRUD, validate, simulate, import/export
- `GET  /_morpheus/api/v1/logs…` — list / detail / body / SSE events
- `*    /_morpheus/api/v1/grpc/descriptors` — descriptor registry
- `GET/PUT /_morpheus/api/v1/logging/mask` — runtime redaction settings
- `GET  /_morpheus/api/v1/metrics`
- `GET  /_morpheus/` — React admin UI (served when `ui/dist` is present)

## Kubernetes / demo

[demo/k8s/morpheus-proxy.yaml](demo/k8s/morpheus-proxy.yaml) deploys morpheus
into a mesh, proxying to a live `ms-a` over HTTP and gRPC. The multi-stage
[Dockerfile](Dockerfile) builds both the proxy and the UI.
