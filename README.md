# morpheus-proxy
A proxy designed for testing

## Proxy

This repository root contains a small Node.js transparent proxy.

- TCP forward for traffic from Istio to a microservice
- HTTP CONNECT proxy for traffic from a microservice to Istio
- Raw request bytes are written to `*.request.bin`
- Raw response bytes are written to `*.response.bin`
- Connection metadata is written to `*.meta.json`

Run locally:

```sh
npm start
```

## Demo

See [demo/README.md](demo/README.md) for a minimal Docker Compose setup with:

```text
(ms-a + morpheus-proxy + istio proxyv2) -> (ms-b + istio proxyv2)
```

`ms-a` exposes echo endpoints over both HTTP and gRPC. Echo requests call `ms-b`
over gRPC through `morpheus-proxy` and the local sidecar chain, and `ms-b`
returns the current UTC time.
