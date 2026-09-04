# Local CONNECT-inspect demo

A minimal, config-driven reproduction of morpheus intercepting a service's
**outbound** calls via an HTTP CONNECT tunnel (docs/spec.md 4.14):

```text
client ── HTTP/gRPC ──▶ ms-a
ms-a ──(GRPC_PROXY_ADDR, HTTP CONNECT)──▶ morpheus-proxy ──▶ ms-b
                                             └─ inspects / mocks / faults ms-a → ms-b
```

`ms-a` keeps its real downstream address (`MS_B_ADDR=ms-b:50052`) **unchanged** and
only gains `GRPC_PROXY_ADDR=morpheus-proxy:15052`. grpc-go opens an HTTP CONNECT
tunnel to morpheus for each downstream dial; morpheus reads the CONNECT authority
(`ms-b:50052`) as the per-connection upstream, runs the rule pipeline on the
plaintext h2c, then forwards to the real `ms-b`.

morpheus is configured entirely by [morpheus.jsonc](morpheus.jsonc) via
`MORPHEUS_CONFIG` — the same way the real app is configured (no env-var wiring).

> **No istio locally.** Docker Compose has no mesh iptables capture, so the mTLS
> hop that happens in a real k8s pod (`morpheus → istio → ms-b`) is omitted here.
> For the in-mesh deployment see [k8s/ms-a-morpheus-connect.yaml](k8s/ms-a-morpheus-connect.yaml)
> and spec 3.2 / 4.14.

## Services

- `ms-a`: echo service (HTTP `GET/POST /echo`, gRPC `demo.EchoService/Echo`). Each
  echo calls `ms-b` for the current time and an animal sound — both through the
  morpheus CONNECT proxy.
- `morpheus-proxy`: one `mode: "connect"` gRPC listener on `:15052`; admin API /
  web UI on `:18081`.
- `ms-b`: `demo.TimeService/Now` and `demo.AnimalSoundService/Sound`, with gRPC
  server reflection enabled so morpheus can fetch its descriptors (spec 4.7.6).
  The services are hand-written (no protoc step), so
  [internal/rpc/descriptor.go](internal/rpc/descriptor.go) registers the
  `proto/demo.proto` file descriptor that generated code would embed — without
  it reflection can list the services but not resolve them.

## Run

```sh
cd demo
docker compose up --build -d
```

The `morpheus-proxy` image builds the root TypeScript proxy (Node.js 24 LTS);
`ms-a` / `ms-b` build from `demo/` (Go).

## Verify (transparent forward)

```sh
curl 'http://localhost:18080/echo?message=hello'
```

Expected — real time from `ms-b` and a real (random) animal sound, i.e. the
CONNECT path forwarded transparently (no rules yet):

```json
{
  "message": "2026-06-03T00:00:00Z hello woof",
  "upstream_time": "2026-06-03T00:00:00Z",
  "animal_sound": "woof",
  "served_by": "ms-a",
  "protocol": "http"
}
```

gRPC echo:

```sh
docker compose run --rm grpcurl \
  -plaintext -import-path /proto -proto demo.proto \
  -d '"hello"' ms-a:50051 demo.EchoService/Echo
```

## See morpheus intercept ms-a → ms-b

Add a capture rule, call `ms-a`, then read the traffic log — the entry proves the
`ms-a → ms-b` gRPC went through morpheus (via CONNECT):

```sh
A=http://localhost:18081/_morpheus/api/v1

# capture every gRPC request morpheus sees
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id":"cap","protocol":"grpc","priority":10,
  "match":{"type":"regex","field":"path","pattern":"^/"},
  "logging":{"capture":true}
}' >/dev/null

curl -s 'http://localhost:18080/echo?message=viaCONNECT' >/dev/null
curl -s "$A/logs?limit=5"   # entries with "listener":"grpc-egress","target":"h2c://ms-b:50052"
```

Inject a consumable fault (first 2 `Now` calls fail, then recover):

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id":"now-fault-2x","protocol":"grpc","priority":100,
  "match":{"type":"regex","field":"path","pattern":"^/demo\\.TimeService/Now$"},
  "request":{"action":{"type":"fault","fault":{"kind":"grpc_status","status":14,"message":"injected"}}},
  "consume":{"times":2}
}' >/dev/null

curl -s 'http://localhost:18080/echo?message=t1'   # ms-a fails to get the time (2x)
curl -s 'http://localhost:18080/echo?message=t2'
curl -s 'http://localhost:18080/echo?message=t3'   # recovered
```

## Message bodies without uploading a .proto (server reflection)

gRPC message bodies (mock `messages`, body matchers, decoded body logging) need a
descriptor. `ms-b` enables gRPC server reflection and [morpheus.jsonc](morpheus.jsonc)
sets `"reflection": { "auto": true }`, so morpheus fetches the descriptors from
`ms-b` itself the first time it sees a method it does not know (spec 4.7.6):

```sh
curl -s 'http://localhost:18080/echo?message=first' >/dev/null   # triggers the import in the background
curl -s "$A/grpc/reflection" | jq .   # "imports": [{ "target": "<ms-b authority>:50052", "protocol": "grpc-v1", ... }]
curl -s "$A/grpc/descriptors" | jq '.items[] | {name, source, services: [.services[].fullName]}'

curl -s 'http://localhost:18080/echo?message=second' >/dev/null  # now decoded: log entries carry the JSON body
curl -s "$A/logs?limit=2" | jq '.items[] | {path: .request.path, body: .response.bodyPreview}'
```

With the schema known, message-level rules validate and apply — mock `Now`:

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id":"mock-now","protocol":"grpc","priority":100,
  "match":{"type":"regex","field":"path","pattern":"^/demo\\.TimeService/Now$"},
  "request":{"action":{"type":"mock_response","response":{"grpcStatus":0,"messages":[{"value":"2000-01-01T00:00:00Z"}]}}}
}' >/dev/null
curl -s 'http://localhost:18080/echo?message=mocked'   # "upstream_time": "2000-01-01T00:00:00Z"
```

The import target is whatever CONNECT authority `ms-a` used — with grpc-go's
default DNS resolver that is the resolved IP (`172.x.x.x:50052`); a client using
the passthrough resolver would show `ms-b:50052`.

To import explicitly instead (or for an upstream you have not called yet):

```sh
curl -s "$A/grpc/descriptors:reflect" -H 'content-type: application/json' -d '{"target":"ms-b:50052"}' | jq .
```

Upstreams without reflection still take a manual upload at `POST $A/grpc/descriptors`
(descriptor set or `.proto` source). See spec 4.7 and api-manual §13.

## Web UI

```sh
open http://localhost:18081/_morpheus/
```

Dashboard (listeners, request counts), Rules, Logs (realtime), Descriptors,
Settings.

## Stop

```sh
docker compose down
```

Host ports default to `18080` (ms-a HTTP), `50051` (ms-a gRPC), `18081`
(morpheus admin/UI); override with `MS_A_HTTP_PORT`, `MS_A_GRPC_PORT`,
`MORPHEUS_PROXY_STATUS_PORT`.
