# morpheus-proxy API 利用ガイド

このガイドは、現行実装と [spec.md](spec.md) に基づく管理 API の使い方です。
例では既定の admin base path `/_morpheus` を使います。

- Web UI の操作は [admin-console-manual.md](admin-console-manual.md)
- Kubernetes への導入手順は [how-to-setup.md](how-to-setup.md)

## 1. 接続先

ローカルまたは port-forward 済みの環境では、まず API ルートを変数化します。

```sh
A=http://localhost:18081/_morpheus/api/v1
BASE=http://localhost:18081/_morpheus
```

Kubernetes 上の Pod 内から直接叩く場合は、morpheus コンテナで実行します。

```sh
kubectl --context=<context> -n <namespace> exec <pod> -c morpheus-proxy -- \
  wget -qO- http://localhost:18081/_morpheus/healthz/ready
```

手元から使う場合は admin port を port-forward します。

```sh
kubectl --context=<context> -n <namespace> port-forward pod/<pod> 18081:18081
```

管理 API / UI には認証がありません。dev 環境だけで使い、remote 公開する場合は公開範囲を制限してください。

## 2. 共通仕様

- JSON body を送る API は `content-type: application/json` を付けます。
- エラーは `{ "error": { "code", "message", "details" } }` 形式です。主な code:

  | HTTP status | code 例 | 意味 |
  | --- | --- | --- |
  | `400` | `rule_validation_failed` / `invalid_json` / `invalid_query` / `duplicate_rule_id` / `descriptor_validation_failed` | 入力不正 |
  | `404` | `rule_not_found` / `log_not_found` / `descriptor_not_found` | 対象なし |
  | `409` | `revision_conflict` | `expectedRevision` が古い |
  | `500` | `internal_error` | proxy 内部エラー |

- rule set には単調増加する `revision` があります。古い状態からの上書きを防ぐには `expectedRevision` を付けます。渡し方は API により異なります:
  - `PUT /rules/:id`、`DELETE /rules/:id`、`POST /rules:disable-all`: query parameter(`?expectedRevision=12`)
  - `POST /rules:import`: request body 内の `expectedRevision` フィールド
  - 不一致の場合は `409 revision_conflict` が返るので、`GET /rules` で再取得してからやり直します。
- rule / descriptor / mask 設定は on-memory です。Pod / process が再起動すると消えるため、共有や再利用には export / import、常設には config の `rules.presets` を使います。
- list logs は `limit` と `cursor` の cursor pagination です。`limit` の既定は 50、最大 200。応答は `{ "items": [...], "nextCursor": "<id>" | null }` で、`nextCursor` を次の `cursor` に渡します。
- admin API の request body は最大 5 MiB です(descriptor 登録もこの制限内)。
- **rule は、rule の `protocol` と同じ protocol の listener を通る traffic にだけ適用されます**(HTTP rule は `protocol: "http"` の listener、gRPC rule は `protocol: "grpc"` の listener)。自環境にどの listener があるかは `GET /status` で確認できます。listener の無い protocol の rule は登録できますが、実 traffic には当たりません(validation / simulation での確認は可能)。

## 3. Health / Status / Metrics

```sh
curl -s "$BASE/healthz/live"
curl -s "$BASE/healthz/ready"
curl -s "$A/status" | jq .
curl -s "$A/metrics" | jq .
curl -s "$BASE/metrics"
```

- `status`: `uptimeMs`、`listeners[]`(name / address / port / activeConnections)、`activeConnections`、`ruleRevision`、`ruleCount`、`logRetention`、`trafficLogCount`、`scriptSandbox` を返します。
- `metrics`(JSON): `requestsByOutcome`(outcome 別 request 数)、`ruleHits`(rule id 別 hit 数)、`faultInjections`、`scriptErrors`、`upstreamLatency`(histogram)、`activeConnections`。
- `$BASE/metrics` は Prometheus text format です(`morpheus_requests_total{outcome=...}`、`morpheus_rule_hits_total{rule=...}`、`morpheus_fault_injections_total`、`morpheus_script_errors_total`、`morpheus_active_connections`、`morpheus_upstream_latency_ms_*`)。

## 4. Rule の基本形と評価規則

最小の capture rule は以下です。`request` / `response` を持たず、`logging.capture: true` のため通信は変更せずログだけ残します。

```json
{
  "id": "capture-users",
  "protocol": "http",
  "priority": 10,
  "match": { "type": "regex", "field": "path", "pattern": "^/users" },
  "logging": { "capture": true }
}
```

主なフィールド:

| field | 必須 | 説明 |
| --- | --- | --- |
| `id` | no | `^[A-Za-z0-9_-]{1,128}$`。省略時は server が生成 |
| `protocol` | yes | `http` / `grpc` |
| `priority` | no(既定 0) | 整数。大きい rule を先に評価 |
| `enabled` | no(既定 true) | `false` の rule は評価しない |
| `match` | yes | request に対する matcher(下表) |
| `request` | no | request 段階 `{ delay?, action? }` |
| `response` | no | response 段階 `{ match?, delay?, action? }` |
| `consume` | no | `{ "times": N, "resetAfterMs"?: ms }`。最初の N 回だけ適用 |
| `logging` | no | `{ "capture": true }` で body を保存 |

### 評価規則

- `request` / `response` を持たない rule は **observation rule**(capture 専用)。一致しても評価を止めず、複数個が同時に capture できます。
- `request` または `response` を持つ rule は **intercept rule**。1 つの request につき、`priority` 降順(同値は作成順)で最初に一致した 1 つだけが適用されます。intercept rule が確定した時点で評価は終わるため、**それより低い priority の capture rule には到達しません**(intercept された traffic はそれ自体が log に記録されるため、確認には支障ありません)。
- `consume.times` を消費しきった rule は「一致しなかった」ものとしてスキップされ、次に一致する rule(より低い priority を含む)が適用されます。どれにも一致しなければ passthrough です。`resetAfterMs` を付けると、最後の消費から指定時間経過後に counter が自動リセットされます。
- `request.action` が `mock_response` / `fault` の場合は upstream へ転送しないため、`response` 段階は実行されません(併記すると validation warning)。
- `response.match` は upstream response への追加条件です。不一致なら response 段階は何もしません。

### Matcher

- `regex`: `{ "type": "regex", "field": <下表>, "pattern": "...", "flags"?: "i" }`。field の候補値のいずれかに一致すれば match です。
- `all` / `any`: `{ "type": "all", "conditions": [matcher, ...] }`、`not`: `{ "type": "not", "condition": matcher }`。
- `script`: JavaScript を sandbox subprocess で実行します(§9)。

`regex` の `field` に使える値は protocol と段階で決まっており、対応外の field は **validation error** になります:

| field(request `match`) | HTTP | gRPC | 値 |
| --- | --- | --- | --- |
| `method` | yes | no | HTTP method |
| `host` | yes | yes | Host / `:authority` |
| `path` | yes | yes | HTTP path / gRPC `/pkg.Service/Method` |
| `query` | yes | no | query string |
| `header.<name>` | yes | yes | HTTP header / gRPC metadata |
| `body` | yes | yes* | text body / decoded gRPC message(JSON 文字列) |
| `rawBodyBase64` | yes | yes | payload の base64 |
| `grpc.service` | no | yes | 例 `demo.TimeService` |
| `grpc.method` | no | yes | 例 `Now` |

| field(`response.match`) | HTTP | gRPC | 値 |
| --- | --- | --- | --- |
| `status` | yes | no | HTTP status(文字列化して regex、例 `^5\\d\\d$`) |
| `header.<name>` | yes | yes | response header / gRPC initial metadata |
| `body` | yes | yes* | text body / decoded gRPC message |
| `rawBodyBase64` | yes | yes | payload の base64 |
| `grpc.status` | no | yes | trailer の grpc-status(文字列化、例 `^0$`) |
| `grpc.trailer.<name>` | no | yes | gRPC trailer |

\* gRPC の `body` は descriptor が登録されている場合のみ decoded JSON に対して match します(§13)。未登録では値が無いため一致しません。

### Action

- `request.action`: `mock_response` / `fault` / `request_rewrite`
- `response.action`: `fault` / `response_replace` / `script_manipulator`

### Delay

`request` / `response` 段階に `delay` を置けます(action と併用可)。

```json
{ "delay": { "durationMs": 500 } }
{ "delay": { "durationMs": 3000, "mode": "total" } }
```

- `fixed`(既定): 指定時間だけ追加で遅延します。
- `total`: request 受理から response 返却開始までの合計が `durationMs` になるよう調整します(client timeout テスト用)。**response 段階専用**です。既に超過していれば追加遅延せず、log の `timing.delaySkipped: true` に記録されます。

## 5. HTTP と gRPC の違い

同じ rule model を使いますが、以下が異なります。

| 項目 | HTTP(`protocol: "http"`) | gRPC(`protocol: "grpc"`) |
| --- | --- | --- |
| listener | HTTP/1.1 / HTTP/2 (h2c) 自動判別 | gRPC over h2c |
| fault kind | `http_response` / `connection` / `timeout` | `grpc_status` / `connection` / `timeout` |
| fault / mock の返り方 | 指定した HTTP status | HTTP status は常に `200`、trailer の `grpc-status` で返す |
| `mock_response` の中身 | `statusCode` / `headers` / `body` | `grpcStatus` / `grpcMessage` / `messages` / `metadata` |
| body の前提 | そのまま扱える(text / JSON / binary) | **descriptor 登録時のみ** decode / match / mock / 改変 / logging 可 |
| `request_rewrite` | 全 op(`set_header` / `remove_header` / `set_path` / `set_query` / `replace_body`) | `set_header` / `remove_header`(= metadata 操作)のみ。他は validation error |
| `response_replace` の対象 | response header | initial metadata |
| streaming | streaming と判定された traffic は body 非対象 | unary 以外(streaming)は body 非対象(metadata / trailer / grpc-status のみ) |
| upstream 障害時 | `502` / `504`(header `x-morpheus-error` 付き) | `grpc-status: 14` / `4` |

gRPC の注意:

- **unary か streaming かの判定は descriptor に依存します。** descriptor 未登録の method はすべて streaming 扱いになり、body を伴う操作(body matcher / mock `messages` / body logging / manipulation)が効きません。metadata / path / grpc-status の rule は descriptor なしで使えます。
- gRPC の mock `messages` は **unary method のみ**、かつ descriptor 必須です。streaming method への mock は validation error(match から method を特定できない場合は実行時に skip)。
- `header.<name>` は gRPC では metadata を参照します。`method` field は gRPC rule では使えません(gRPC は常に POST)。

`grpc_status` fault / `grpcStatus` に使う値(主要なもの):

| status | 名前 | | status | 名前 |
| --- | --- | --- | --- | --- |
| 0 | OK | | 8 | RESOURCE_EXHAUSTED |
| 1 | CANCELLED | | 10 | ABORTED |
| 3 | INVALID_ARGUMENT | | 12 | UNIMPLEMENTED |
| 4 | DEADLINE_EXCEEDED | | 13 | INTERNAL |
| 5 | NOT_FOUND | | 14 | UNAVAILABLE |
| 7 | PERMISSION_DENIED | | 16 | UNAUTHENTICATED |

## 6. Rule CRUD

一覧(応答は `{ "revision": N, "items": [ { "rule": {...}, "state": {...} } ] }`):

```sh
curl -s "$A/rules" | jq .
curl -s "$A/rules" | jq -r .revision
curl -s "$A/rules" | jq '.items[].rule.id'
```

作成前 validation(単体 rule または rule の配列を受け付け、登録せずに errors / warnings を返します):

```sh
curl -s "$A/rules:validate" \
  -H 'content-type: application/json' \
  -d '{"protocol":"http","match":{"type":"regex","field":"path","pattern":"^/"},"logging":{"capture":true}}' | jq .
```

作成(成功時 `201`):

```sh
curl -s "$A/rules" \
  -H 'content-type: application/json' \
  -d '{"id":"capture-all-http","protocol":"http","priority":10,"match":{"type":"regex","field":"path","pattern":"^/"},"logging":{"capture":true}}' | jq .
```

更新:

```sh
REV=$(curl -s "$A/rules" | jq -r .revision)
curl -s -X PUT "$A/rules/capture-all-http?expectedRevision=$REV" \
  -H 'content-type: application/json' \
  -d '{"id":"capture-all-http","protocol":"http","priority":20,"match":{"type":"regex","field":"path","pattern":"^/"},"logging":{"capture":true}}' | jq .
```

削除:

```sh
REV=$(curl -s "$A/rules" | jq -r .revision)
curl -s -X DELETE "$A/rules/capture-all-http?expectedRevision=$REV" | jq .
```

全 rule disable:

```sh
REV=$(curl -s "$A/rules" | jq -r .revision)
curl -s -X POST "$A/rules:disable-all?expectedRevision=$REV" | jq .
```

consume state(応答は `{ "ruleId", "hits", "consumed", "remaining", "lastMatchedAt" }`。`remaining` は consume の無い rule では `null`):

```sh
curl -s "$A/rules/<rule-id>/state" | jq .
curl -s -X POST "$A/rules/<rule-id>/state:reset" | jq .
```

rule の update / delete でも counter は初期化されます。

## 7. よく使う Rule 例(HTTP)

HTTP mock response:

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "mock-users",
  "protocol": "http",
  "priority": 100,
  "match": { "type": "regex", "field": "path", "pattern": "^/users/\\d+$" },
  "request": {
    "action": {
      "type": "mock_response",
      "response": {
        "statusCode": 200,
        "headers": { "content-type": "application/json" },
        "body": "{\"name\":\"mock-user\"}"
      }
    }
  }
}' | jq .
```

HTTP 503 を最初の 2 回だけ返す:

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "users-503-twice",
  "protocol": "http",
  "priority": 100,
  "match": { "type": "regex", "field": "path", "pattern": "^/users" },
  "request": {
    "action": {
      "type": "fault",
      "fault": {
        "kind": "http_response",
        "statusCode": 503,
        "headers": { "content-type": "application/json" },
        "body": "{\"error\":\"injected\"}"
      }
    }
  },
  "consume": { "times": 2 }
}' | jq .
```

response を 500ms 遅延:

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "delay-users",
  "protocol": "http",
  "priority": 50,
  "match": { "type": "regex", "field": "path", "pattern": "^/users" },
  "response": { "delay": { "durationMs": 500 } }
}' | jq .
```

request header と query を書き換えて upstream に送る:

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "rewrite-users",
  "protocol": "http",
  "priority": 80,
  "match": { "type": "regex", "field": "path", "pattern": "^/users" },
  "request": {
    "action": {
      "type": "request_rewrite",
      "operations": [
        { "op": "set_header", "name": "x-test-case", "value": "morpheus" },
        { "op": "set_query", "value": "debug=true" }
      ]
    }
  }
}' | jq .
```

`operations` には他に `remove_header`、`set_path`、`replace_body`(`from` regex → `to`、text body のみ)があります。

upstream が 5xx のときだけ response header を正規表現置換:

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "replace-source-header",
  "protocol": "http",
  "priority": 70,
  "match": { "type": "regex", "field": "path", "pattern": "^/" },
  "response": {
    "match": { "type": "regex", "field": "status", "pattern": "^5\\d\\d$" },
    "action": {
      "type": "response_replace",
      "target": "header.x-data-source",
      "from": "^real-(.*)$",
      "to": "mock-$1"
    }
  }
}' | jq .
```

(`response.match` を省略すればすべての response に適用されます。`response_replace` の `target` は `header.<name>` 形式のみです。)

script matcher / script manipulator の HTTP 例は §9 を参照してください。

## 8. よく使う Rule 例(gRPC)

前提の整理:

- fault(`grpc_status`)、metadata 操作、delay、capture(metadata のみ)は **descriptor なし**で使えます。
- body(message)の decode / match / mock / 改変 / logging には **descriptor 登録(§13)が必要**です。descriptor が無い method は streaming 扱いになり body が保存されません。
- method の指定は `path` に対する literal regex(`^/pkg\\.Service/Method$`)か、`grpc.service` / `grpc.method` の組み合わせで行います。**mock で `messages` を使う rule は literal な path match を推奨**します(登録時に message schema を検証できるため)。

capture(service 単位で body を保存。decoded JSON が残るのは descriptor 登録済みの場合):

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "capture-timeservice",
  "protocol": "grpc",
  "priority": 10,
  "match": { "type": "regex", "field": "grpc.service", "pattern": "^demo\\.TimeService$" },
  "logging": { "capture": true }
}' | jq .
```

gRPC UNAVAILABLE を最初の 2 回だけ返す(descriptor 不要):

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "grpc-now-unavailable-twice",
  "protocol": "grpc",
  "priority": 100,
  "match": { "type": "regex", "field": "path", "pattern": "^/demo\\.TimeService/Now$" },
  "request": {
    "action": {
      "type": "fault",
      "fault": { "kind": "grpc_status", "status": 14, "message": "injected unavailable" }
    }
  },
  "consume": { "times": 2 }
}' | jq .
```

gRPC unary の mock response(**descriptor 必須**。`messages` は response message の JSON 表現で、schema に合わないと登録時に `invalid_message` エラー):

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "mock-now",
  "protocol": "grpc",
  "priority": 100,
  "match": { "type": "regex", "field": "path", "pattern": "^/demo\\.TimeService/Now$" },
  "request": {
    "action": {
      "type": "mock_response",
      "response": {
        "grpcStatus": 0,
        "messages": [ { "iso": "2026-01-01T00:00:00Z" } ],
        "metadata": { "x-morpheus-mock": "true" }
      }
    }
  }
}' | jq .
```

metadata を条件にする / metadata を書き換える(descriptor 不要):

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "grpc-rewrite-metadata",
  "protocol": "grpc",
  "priority": 80,
  "match": {
    "type": "all",
    "conditions": [
      { "type": "regex", "field": "grpc.service", "pattern": "^demo\\.TimeService$" },
      { "type": "regex", "field": "header.x-test", "pattern": "^1$" }
    ]
  },
  "request": {
    "action": {
      "type": "request_rewrite",
      "operations": [ { "op": "set_header", "name": "x-test-case", "value": "morpheus" } ]
    }
  }
}' | jq .
```

(gRPC の `request_rewrite` は `set_header` / `remove_header` のみです。`set_path` / `replace_body` などは validation error になります。)

upstream が成功(grpc-status 0)したときだけ UNAVAILABLE に差し替える(`response.match` の例、descriptor 不要):

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "grpc-poison-success",
  "protocol": "grpc",
  "priority": 100,
  "match": { "type": "regex", "field": "path", "pattern": "^/demo\\.TimeService/Now$" },
  "response": {
    "match": { "type": "regex", "field": "grpc.status", "pattern": "^0$" },
    "action": {
      "type": "fault",
      "fault": { "kind": "grpc_status", "status": 14, "message": "injected after success" }
    }
  },
  "consume": { "times": 1 }
}' | jq .
```

response message を script manipulator で書き換える(**descriptor 必須**。patch の `messages` は response message の JSON 配列):

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "grpc-edit-response",
  "protocol": "grpc",
  "priority": 60,
  "match": { "type": "regex", "field": "path", "pattern": "^/demo\\.TimeService/Now$" },
  "response": {
    "action": {
      "type": "script_manipulator",
      "language": "javascript",
      "timeoutMs": 3000,
      "source": "const msgs = (ctx.response.grpc && ctx.response.grpc.messages) || []; return { messages: msgs.map(m => ({ ...m, iso: \"mock-\" + m.iso })) };"
    }
  }
}' | jq .
```

streaming method に対しては、fault(`grpc_status` / `connection` / `timeout`)、delay、metadata の rewrite、`response.match`(`header.<name>` / `grpc.status` / `grpc.trailer.<name>`)、script manipulator の `metadata` / `trailers` / `grpcStatus` / `grpcMessage` patch が使えます。body 系(`messages` / `replace_body` / body matcher)は評価されず、warning または skip として記録されます。

script source は export と log に残ります。secret を埋め込まないでください。

## 9. Script rule(ctx と patch)

script matcher(`match.type: "script"`)と script manipulator(`response.action.type: "script_manipulator"`)は、proxy 本体と別の sandbox subprocess で実行されます。関数本体だけを `source` に書きます(`return` が必要)。

matcher は boolean を返します:

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "script-match-header",
  "protocol": "http",
  "priority": 90,
  "match": {
    "type": "script",
    "language": "javascript",
    "timeoutMs": 3000,
    "source": "return ctx.request.path.startsWith(\"/users\") && ctx.request.headers[\"x-test\"] === \"1\";"
  },
  "request": {
    "action": {
      "type": "mock_response",
      "response": { "statusCode": 200, "body": "script matched" }
    }
  }
}' | jq .
```

manipulator は response への部分 patch を返します(HTTP の例):

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "edit-response-body",
  "protocol": "http",
  "priority": 60,
  "match": { "type": "regex", "field": "path", "pattern": "^/echo" },
  "response": {
    "action": {
      "type": "script_manipulator",
      "language": "javascript",
      "timeoutMs": 3000,
      "source": "return { body: (ctx.response.body || \"\").replace(\"real\", \"mock\") };"
    }
  }
}' | jq .
```

`ctx` の形(matcher / manipulator 共通。TypeScript 風の擬似定義):

```ts
ctx = {
  protocol: 'http' | 'grpc',
  stage: 'request' | 'response',
  request: {
    id, method?, host?, path?, query?,
    headers,            // 小文字 key。gRPC では metadata と同じ内容
    body?,              // text body。gRPC では decoded message の JSON 文字列(descriptor 必須)
    rawBodyBase64?,
    grpc?: { service?, method?, metadata, messages? },  // messages: decoded JSON(descriptor 必須)
  },
  response?: {          // stage === 'response' のときのみ
    statusCode?, headers, body?, rawBodyBase64?,
    grpc?: { status?, message?, trailers, messages? },
  },
  ruleState: { hits, remaining? },
  upstream?: { durationMs, error? },   // manipulator のみ
}
```

manipulator の戻り値(すべて optional の部分 patch。指定しない field は upstream のまま):

```ts
// protocol: "http" の rule
return { statusCode?, headers?, body?, rawBodyBase64? };
// protocol: "grpc" の rule
return { metadata?, messages?, grpcStatus?, grpcMessage?, trailers? };
```

- `headers` / `metadata` / `trailers` の値に `null` を渡すと、その header を削除します。
- `body` と `rawBodyBase64` の同時指定はエラー(rule execution failure として passthrough)。
- gRPC の `messages` patch は descriptor 必須です。encode に失敗した場合は upstream response をそのまま返し、エラーを log に記録します。
- protocol に合わない field(HTTP rule での `grpcStatus` など)は無視され、warning が application log に残ります。

実行制御:

- sandbox では `fs` / `net` / `process` / dynamic import が使えません。
- timeout の既定は 3 秒(rule の `timeoutMs` で変更、上限は config `script.maxTimeoutMs`、既定 60 秒)。
- script の error / timeout 時は request / response を変更せず passthrough し、traffic log(`ruleErrors`)と application log に記録されます。outcome は `rule_error` になります。

## 10. Simulation

登録済み log か sample request に対して、現在の rule set または `ruleDraft` を適用した結果を返します。upstream には送信せず、consume counter も消費しません。

入力の規則:

- `logIds` と `sampleRequest` はどちらか一方が必須(両方は `400`)。
- `ruleDraft` を省略すると現在の rule set 全体を適用します。
- `sampleResponse` は `sampleRequest` と併用し、response 段階も simulate したいときに渡します。
- log に body が保存されていない場合、body を使う action は `skipped: body_not_logged` になります。
- `options.includeBodyDiff: true` で body の before / after が結果に含まれます。

sample request に draft rule を当てる(HTTP):

```sh
curl -s "$A/rules:simulate" \
  -H 'content-type: application/json' \
  -d '{
    "sampleRequest": {
      "protocol": "http",
      "method": "GET",
      "path": "/users/1",
      "headers": { "x-test": "1" }
    },
    "ruleDraft": {
      "protocol": "http",
      "match": { "type": "regex", "field": "path", "pattern": "^/users" },
      "request": {
        "action": {
          "type": "mock_response",
          "response": { "statusCode": 200, "body": "mock" }
        }
      }
    }
  }' | jq .
```

gRPC の sample は `path` を `/pkg.Service/Method` 形式にします(`grpc.service` / `grpc.method` は path から自動抽出され、`headers` は metadata として扱われます)。`body` には decoded message の JSON 文字列を渡します:

```sh
curl -s "$A/rules:simulate" \
  -H 'content-type: application/json' \
  -d '{
    "sampleRequest": {
      "protocol": "grpc",
      "path": "/demo.TimeService/Now",
      "headers": { "x-test": "1" },
      "body": "{\"tz\":\"UTC\"}"
    },
    "sampleResponse": {
      "grpcStatus": 0,
      "headers": {},
      "body": "{\"iso\":\"2026-01-01T00:00:00Z\"}"
    }
  }' | jq .
```

保存済み log に現在の rule set を当てる:

```sh
LOG_ID=$(curl -s "$A/logs?limit=1" | jq -r '.items[0].id')
curl -s "$A/rules:simulate" \
  -H 'content-type: application/json' \
  -d "{\"logIds\":[\"$LOG_ID\"],\"options\":{\"includeBodyDiff\":true}}" | jq .
```

結果の `results[]` には `matchedRules`、`interceptRule`、`outcome`(`passthrough` / `captured` / `mock` / `fault` / `modified` / `delayed` / `rule_error`)、`requestStage` / `responseStage`(適用される action と would-be 結果)、`errors` が入ります。

## 11. Import / Export

全 rule を export:

```sh
curl -s "$A/rules:export" -H 'content-type: application/json' -d '{}' > morpheus-rules.json
```

一部だけ export:

```sh
curl -s "$A/rules:export" \
  -H 'content-type: application/json' \
  -d '{"ids":["mock-users","delay-users"]}' | jq .
```

merge import(`id` が一致する rule は上書き、他は追加):

```sh
curl -s "$A/rules:import" \
  -H 'content-type: application/json' \
  --data-binary @<(jq '{mode:"merge", rules:.rules}' morpheus-rules.json) | jq .
```

replace import(rule set 全体を置き換え):

```sh
REV=$(curl -s "$A/rules" | jq -r .revision)
curl -s "$A/rules:import" \
  -H 'content-type: application/json' \
  --data-binary @<(jq --argjson rev "$REV" '{mode:"replace", expectedRevision:$rev, rules:.rules}' morpheus-rules.json) | jq .
```

- Import は全 rule を validation してから atomic に反映します。1 つでも invalid なら何も変更しません。
- 上書きされた rule の consume counter は初期化されます。
- export に実行時 state(hits / remaining)と gRPC descriptor は含まれません。descriptor は §13 の API で別途登録します。

## 12. Log API

保存されるのは capture rule に一致した、または intercept / manipulation / fault / mock / upstream_error が起きた traffic だけです。**unmatched passthrough traffic は保存されません。** body を残したい場合は、まず capture rule を登録してください。

一覧:

```sh
curl -s "$A/logs?limit=50" | jq .
```

filter 一覧(組み合わせ可):

| query | 一致方法 | 例 |
| --- | --- | --- |
| `protocol` | `http` / `grpc` | `protocol=grpc` |
| `outcome` | 完全一致(`captured` / `mock` / `fault` / `modified` / `delayed` / `upstream_error` / `rule_error`) | `outcome=fault` |
| `method` | 完全一致 | `method=GET` |
| `path` | 部分一致 | `path=/users` |
| `grpcService` / `grpcMethod` | 完全一致(gRPC のみ) | `grpcService=demo.TimeService&grpcMethod=Now` |
| `ruleId` | matched rule に含まれる | `ruleId=grpc-now-unavailable-twice` |
| `statusCode` / `grpcStatus` | 完全一致 | `grpcStatus=14` |
| `from` / `to` | `startedAt`(ISO 8601)との範囲比較 | `from=2026-07-09T00:00:00Z` |
| `contains` | id / path / body preview / headers への部分一致 | `contains=injected` |

```sh
curl -s "$A/logs?protocol=http&outcome=mock&limit=20" | jq .
curl -s "$A/logs?protocol=grpc&grpcService=demo.TimeService&grpcStatus=14" | jq .
```

詳細(entry には `outcome`、`matchedRules[]`(consumed / remaining 含む)、`request` / `response` の headers・`bodyPreview`(既定 4KB, mask 適用済み)、rewrite 時の `forwardedRequest`、manipulation 時の `upstreamResponse`、`ruleErrors`、`timing` が入ります):

```sh
curl -s "$A/logs/$LOG_ID" | jq .
```

保存済み body の download:

```sh
curl -sS "$A/logs/$LOG_ID/request" -o request.bin
curl -sS "$A/logs/$LOG_ID/response" -o response.bin
curl -sS "$A/logs/$LOG_ID/request?variant=forwarded" -o forwarded-request.bin
curl -sS "$A/logs/$LOG_ID/response?variant=upstream" -o upstream-response.bin
```

| endpoint | variant | 内容 |
| --- | --- | --- |
| `/logs/:id/request` | (なし) / `original` | client が送った request body |
| `/logs/:id/request` | `forwarded` | request_rewrite 後に upstream へ送った body |
| `/logs/:id/response` | (なし) / `returned` | client に返した response body |
| `/logs/:id/response` | `upstream` | manipulation 前の upstream response body |

- body が保存されていない場合は binary ではなく `bodyLogged: false`(+ `bodyLoggingSkippedReason`)と metadata の JSON が返ります。
- **gRPC の保存 body は decoded message の JSON テキストです**(descriptor 登録時のみ保存)。protobuf バイナリそのものではありません。descriptor が無い gRPC traffic は metadata / grpc-status のみ記録され、body は保存されません。
- HTTP の body は raw バイト列で、buffering limit(既定 1 MiB)を超えたものは保存されず `bodyLoggingSkippedReason: "limit_exceeded"` になります。

1 件 export(metadata + 保存済み body の base64 を含む自己完結 JSON):

```sh
curl -s "$A/logs/$LOG_ID/export" | jq .
```

SSE で新規 log を購読:

```sh
curl -N "$A/logs/events"
```

全 log 削除:

```sh
curl -s -X DELETE "$A/logs" | jq .
```

## 13. gRPC Descriptor

gRPC body の decode、body matcher、mock `messages`、message manipulation、body logging には descriptor が必要です。
metadata / path / grpc-status のみを扱う rule は descriptor なしで使えます。
descriptor も on-memory のため、再起動後は再登録が必要です。

### `.proto` source の登録

```sh
curl -s "$A/grpc/descriptors" \
  -H 'content-type: application/json' \
  -d @- <<'JSON' | jq .
{
  "name": "demo.proto",
  "format": "proto_source",
  "content": "syntax = \"proto3\";\npackage demo;\nservice TimeService { rpc Now (NowRequest) returns (NowResponse); }\nmessage NowRequest { string tz = 1; }\nmessage NowResponse { string iso = 1; }\n"
}
JSON
```

応答には `id`(`desc-xxxxxxxx` 形式)と、解決された `services[]`(fullName / methods / streaming フラグ)が含まれます。rule が対象にする service / method がここに出ていることを確認してください。

**import の制約**: `proto_source` では well-known types(`google/protobuf/*.proto`: timestamp / duration / struct / wrappers / empty / any / field_mask など)の import だけが自動解決されます。**自作 proto の import は解決できません**。社内サービスのように複数ファイル構成の proto は、次のどちらかにします。

1. 依存をひとつの `.proto` に手動で統合して `proto_source` で登録する(小規模ならこれで十分)
2. `descriptor_set` で登録する(**推奨**。依存込みでそのまま入る)

### descriptor set binary の登録

`protoc` の `--include_imports` 付き descriptor set、または `buf build` の出力を base64 で渡します。

```sh
# protoc の場合(--include_imports が必須)
protoc -I <proto-root> --include_imports \
  --descriptor_set_out=/tmp/svc.binpb <proto-root>/path/to/service.proto
# buf の場合(imports は既定で含まれる)
# buf build -o /tmp/svc.binpb

B64=$(base64 < /tmp/svc.binpb | tr -d '\n')
jq -n --arg name "service.binpb" --arg content "$B64" \
  '{name: $name, format: "descriptor_set", content: $content}' |
curl -s "$A/grpc/descriptors" -H 'content-type: application/json' --data-binary @- | jq .
```

admin API の body 上限は 5 MiB です(base64 で約 1.33 倍になる点に注意)。大きすぎる場合は対象サービスの proto だけで descriptor set を作ってください。

### 一覧 / 削除

```sh
curl -s "$A/grpc/descriptors" | jq .
curl -s "$A/grpc/descriptors" | jq -r '.items[] | "\(.id)\t\(.name)"'
curl -s -X DELETE "$A/grpc/descriptors/<descriptor-id>" | jq .
```

### 登録後の効果と注意

- 登録した瞬間から、該当 method の unary 判定・body decode・capture の decoded JSON 保存・mock `messages`・script の `ctx.request.grpc.messages` / `ctx.response.grpc.messages` が有効になります。
- **descriptor 登録前に capture した log には decoded body は入っていません。** body を使った simulation をしたい場合は、descriptor 登録後に traffic を流し直してください。
- mock `messages` の schema validation は、match から対象 method を特定できる場合(literal な path match など)に登録時に行われます。特定できない場合は実行時の encode で検証され、失敗すると `grpc-status 13 INTERNAL` が返り log に記録されます。

## 14. Masking

現在の mask 設定:

```sh
curl -s "$A/logging/mask" | jq .
```

置き換え(部分更新ではなく全置換です。既存の値に追加する場合は GET の結果に足して PUT します):

```sh
curl -s -X PUT "$A/logging/mask" \
  -H 'content-type: application/json' \
  -d '{
    "headers": ["authorization", "cookie", "set-cookie", "x-api-key", "x-secret"],
    "jsonPaths": ["$.password", "$.token", "$.credentials.*"]
  }' | jq .
```

- mask は log の headers、JSON body preview、decoded gRPC body preview に適用されます(raw body file には適用されません)。
- 変更は on-memory です。再起動すると config の `logging.mask`(既定: `authorization` / `cookie` / `set-cookie` / `x-api-key`)に戻ります。

## 15. 推奨ワークフロー

1. (gRPC で body を扱う場合)descriptor を登録します(§13)。
2. capture rule を登録します(§4)。
3. app から対象 traffic を発生させます。
4. `GET /logs` と body preview / body download で対象 log を確認します。
5. `rules:simulate` で draft rule を保存済み log または sample request に当てます(§10)。
6. `rules:validate` で validation を通します。
7. `POST /rules` で rule を hot load します。
8. app の挙動、`/rules/:id/state`、`/logs`、`/metrics` を確認します。
9. 使い終わった rule は delete または disable-all し、必要なら export します。

## 16. Kubernetes / CONNECT listener での注意

### Pod 内からの API 操作

morpheus コンテナ内の busybox `wget` は DELETE を扱えない場合があります。DELETE や複雑な body は port-forward した手元の `curl` を使うか、コンテナ内の Node.js fetch を使います。

```sh
kubectl --context=<context> -n <namespace> exec <pod> -c morpheus-proxy -- \
  node -e "fetch('http://localhost:18081/_morpheus/api/v1/rules/ID',{method:'DELETE'}).then(async r=>console.log(r.status, await r.text()))"
```

### CONNECT egress listener を使う場合の client 設定

`mode: "connect"` の listener は標準的な HTTP CONNECT proxy として振る舞い、CONNECT の宛先(authority)がそのままその接続の upstream になります。app 側は下流アドレスを一切変えず、client の proxy 設定だけを足します。設定方法は 2 通りあります。

1. **専用 dialer(推奨)**: 対象の gRPC client にだけ CONNECT dialer を差します。grpc-go なら `grpc.WithContextDialer` に数行の CONNECT dialer を渡します(実装例: [demo/cmd/ms-a/main.go](../demo/cmd/ms-a/main.go) の `connectProxyDialer`)。demo で使っている `GRPC_PROXY_ADDR` は **この dialer にアドレスを渡すためのアプリ独自 env であり、grpc-go の標準環境変数ではありません**。効かせる client を明示的に選べるため、外部 TLS client を巻き込む事故が起きません。
2. **言語標準の proxy env**: grpc-go / Go `net/http` / `@grpc/grpc-js` などは `HTTPS_PROXY` を尊重します。コード変更は不要ですが **process 全体に効く**ため、Spanner / GCS / 外部 SaaS など client 終端 TLS の宛先を必ず `NO_PROXY` に入れてください。morpheus は平文(h2c / HTTP)しか扱えず、TLS のトンネルは接続確立の時点で失敗します。

その他の CONNECT の性質:

- opt-in です。proxy 設定をした client の通信だけが morpheus を通り、設定しない client は素通り(傍受されない)です。
- rule / logging / consume の挙動は reverse listener と同一で、traffic log の `target` に CONNECT の宛先が記録されます。
- CONNECT 以外の request を受けた場合は `405` を返します。grpcurl などで疎通確認をしたい場合は、connect listener に直接投げるのではなく、一時的に reverse listener(`upstream` 固定)を足すか app 経由で traffic を流してください。
