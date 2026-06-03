# Local sidecar demo

This directory contains a minimal local reproduction of this request path:

```text
client -> ms-a-istio -> morpheus-proxy -> ms-a
ms-a -> morpheus-proxy -> ms-a-istio -> ms-b-istio -> ms-b
```

It uses `docker.io/istio/proxyv2` as the Envoy sidecar image. Docker Compose
does not reproduce Kubernetes pod networking or Istio iptables capture, so
`ms-a` explicitly connects to `morpheus-proxy:15000` with HTTP CONNECT, and the
proxy connects to the local outbound Istio listener at `ms-a-istio:15001`.

## Services

- `ms-a`: echo service
  - HTTP: `GET /echo?message=hello` or `POST /echo`
  - gRPC: `demo.EchoService/Echo`
- `morpheus-proxy`: transparent Node.js proxy between `ms-a` and `ms-a-istio`
  - TCP forward: `ms-a-istio -> morpheus-proxy -> ms-a`
  - HTTP CONNECT: `ms-a -> morpheus-proxy -> ms-a-istio`
  - gRPC early return: `/demo.AnimalSoundService/Sound` returns `Dummy`
  - logs raw request and response bytes under `demo/logs/morpheus-proxy`
- `ms-b`: time service
  - gRPC: `demo.TimeService/Now`
  - gRPC: `demo.AnimalSoundService/Sound`
- `ms-a-istio`: inbound HTTP/gRPC to `morpheus-proxy`, outbound gRPC to `ms-b-istio`
- `ms-b-istio`: inbound gRPC for `ms-b`

Every echo response includes the echoed message and the current UTC time
returned by `ms-b`, so the proxy and sidecar path is exercised for both HTTP and
gRPC echo requests.

The echo response `message` is formatted as:

```text
{time from ms-b} {request message} {animal sound}
```

In this Docker Compose setup, the animal sound request is early-returned by
`morpheus-proxy`, so the animal sound is always `Dummy`. Calling `ms-b` directly
returns a random animal sound.

## Run

```sh
cd demo
docker compose up --build -d
```

The `morpheus-proxy` image builds the root TypeScript proxy with Node.js
24.16.0 LTS and then runs the compiled ESM output.

## Verify HTTP

```sh
curl 'http://localhost:18080/echo?message=hello'
```

Expected shape:

```json
{
  "message": "2026-06-03T00:00:00Z hello Dummy",
  "upstream_time": "2026-06-03T00:00:00Z",
  "animal_sound": "Dummy",
  "served_by": "ms-a",
  "protocol": "http"
}
```

## Verify gRPC

```sh
docker compose run --rm grpcurl \
  -plaintext \
  -import-path /proto \
  -proto demo.proto \
  -d '"hello"' \
  ms-a-istio:50051 \
  demo.EchoService/Echo
```

Expected shape:

```json
{
  "message": "2026-06-03T00:00:00Z hello Dummy",
  "animal_sound": "Dummy",
  "protocol": "grpc",
  "served_by": "ms-a",
  "upstream_time": "2026-06-03T00:00:00Z"
}
```

## Verify ms-b random animal sound directly

```sh
docker compose run --rm grpcurl \
  -plaintext \
  -import-path /proto \
  -proto demo.proto \
  -d '{}' \
  ms-b-istio:50052 \
  demo.AnimalSoundService/Sound
```

## Inspect proxy logs

```sh
find logs/morpheus-proxy -type f | sort
```

Each proxied connection writes:

- `*.request.bin`: bytes sent toward the upstream service
- `*.response.bin`: bytes sent back to the caller
- `*.meta.json`: connection metadata

## Stop

```sh
docker compose down
```

The default host ports are `18080` for HTTP and `15051` for gRPC. Override them
with `MS_A_HTTP_PORT` and `MS_A_GRPC_PORT` if needed.
