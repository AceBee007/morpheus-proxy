# morpheus-proxy
A proxy designed for testing

## Proxy

This repository root contains a small Node.js transparent proxy.

- Runtime: Node.js 24.16.0 LTS
- Language: TypeScript 6.0.3
- Module system: ECMAScript modules with `moduleResolution: NodeNext`
- ECMAScript target/library: `ESNext`

- TCP forward for traffic from Istio to a microservice
- HTTP CONNECT proxy for traffic from a microservice to Istio
- Raw request bytes are written to `*.request.bin`
- Raw response bytes are written to `*.response.bin`
- Connection metadata is written to `*.meta.json`

Run locally:

```sh
npm install
npm run build
npm start
```

Validate locally:

```sh
npm run check
```

## Demo

See [demo/README.md](demo/README.md) for a minimal Docker Compose setup with:

```text
(ms-a + morpheus-proxy + istio proxyv2) -> (ms-b + istio proxyv2)
```

`ms-a` exposes echo endpoints over both HTTP and gRPC. Echo requests call `ms-b`
over gRPC through `morpheus-proxy` and the local sidecar chain, and `ms-b`
returns the current UTC time.
