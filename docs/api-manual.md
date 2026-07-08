# morpheus-proxy API 利用ガイド

このガイドは、現行実装と [spec.md](spec.md) に基づく管理 API の使い方です。
例では既定の admin base path `/_morpheus` を使います。

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
- エラーは `{ "error": { "code", "message", "details" } }` 形式です。
- rule set には単調増加する `revision` があります。`PUT` / `DELETE` / import / disable-all では `expectedRevision` を付けると古い上書きを `409 revision_conflict` で防げます。
- rule は on-memory です。Pod / process が再起動すると消えるため、共有や再利用には export / import、常設には config の `rules.presets` を使います。
- list logs は `limit` と `cursor` の cursor pagination です。`limit` は最大 200 です。

## 3. Health / Status / Metrics

```sh
curl -s "$BASE/healthz/live"
curl -s "$BASE/healthz/ready"
curl -s "$A/status" | jq .
curl -s "$A/metrics" | jq .
curl -s "$BASE/metrics"
```

`status` では listener、active connection、`ruleRevision` / `ruleCount`、`logRetention`、`trafficLogCount`、script sandbox 状態を確認できます。
`metrics` は outcome 別 request 数、rule hit、fault injection 数、script error 数、upstream latency を返します。
`$BASE/metrics` は Prometheus text format です。

## 4. Rule の基本形

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

主な matcher:

- `regex`: `field` と `pattern` で一致判定します。
- `all` / `any` / `not`: matcher を組み合わせます。
- `script`: JavaScript を sandbox subprocess で実行します。

request action:

- `mock_response`
- `fault`
- `request_rewrite`

response action:

- `fault`
- `response_replace`
- `script_manipulator`

`consume.times` を付けると最初の N 回だけ適用され、消費後は次の rule または passthrough に戻ります。

## 5. Rule CRUD

一覧:

```sh
curl -s "$A/rules" | jq .
```

作成前 validation:

```sh
curl -s "$A/rules:validate" \
  -H 'content-type: application/json' \
  -d '{"protocol":"http","match":{"type":"regex","field":"path","pattern":"^/"},"logging":{"capture":true}}' | jq .
```

作成:

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

consume state:

```sh
curl -s "$A/rules/<rule-id>/state" | jq .
curl -s -X POST "$A/rules/<rule-id>/state:reset" | jq .
```

## 6. よく使う Rule 例

HTTP rule の実 traffic 適用には HTTP listener が必要です。CONNECT egress demo の GKE 構成は gRPC listener のみなので、HTTP rule は API validation / simulation で確認し、実 traffic では gRPC rule を使います。

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

gRPC UNAVAILABLE を最初の 2 回だけ返す:

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

response header を正規表現置換:

```sh
curl -s "$A/rules" -H 'content-type: application/json' -d '{
  "id": "replace-source-header",
  "protocol": "http",
  "priority": 70,
  "match": { "type": "regex", "field": "path", "pattern": "^/" },
  "response": {
    "action": {
      "type": "response_replace",
      "target": "header.x-data-source",
      "from": "^real-(.*)$",
      "to": "mock-$1"
    }
  }
}' | jq .
```

script matcher:

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

response body を script manipulator で置換:

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

script source は export と log に残ります。secret を埋め込まないでください。

## 7. Simulation

sample request に draft rule を当てる:

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

保存済み log に現在の rule set を当てる:

```sh
LOG_ID=$(curl -s "$A/logs?limit=1" | jq -r '.items[0].id')
curl -s "$A/rules:simulate" \
  -H 'content-type: application/json' \
  -d "{\"logIds\":[\"$LOG_ID\"],\"options\":{\"includeBodyDiff\":true}}" | jq .
```

Simulation は upstream に送信せず、consume counter も消費しません。

## 8. Import / Export

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

merge import:

```sh
curl -s "$A/rules:import" \
  -H 'content-type: application/json' \
  --data-binary @<(jq '{mode:"merge", rules:.rules}' morpheus-rules.json) | jq .
```

replace import:

```sh
REV=$(curl -s "$A/rules" | jq -r .revision)
curl -s "$A/rules:import" \
  -H 'content-type: application/json' \
  --data-binary @<(jq --argjson rev "$REV" '{mode:"replace", expectedRevision:$rev, rules:.rules}' morpheus-rules.json) | jq .
```

Import は全 rule を validation してから atomic に反映します。1 つでも invalid なら何も変更しません。

## 9. Log API

一覧:

```sh
curl -s "$A/logs?limit=50" | jq .
```

よく使う filter:

```sh
curl -s "$A/logs?protocol=http&outcome=mock&limit=20" | jq .
curl -s "$A/logs?protocol=grpc&grpcService=demo.TimeService&limit=20" | jq .
curl -s "$A/logs?ruleId=grpc-now-unavailable-twice&limit=20" | jq .
curl -s "$A/logs?contains=injected&limit=20" | jq .
```

詳細:

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

body が保存されていない場合は binary ではなく、`bodyLogged: false` と metadata の JSON が返ります。

1 件 export:

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

unmatched passthrough traffic は保存されません。body を残したい場合は、まず capture rule を登録してください。

## 10. gRPC Descriptor

gRPC body の decode、body matcher、mock message、message manipulation には descriptor が必要です。
metadata / path / grpc-status のみを扱う fault は descriptor なしで使えます。

`.proto` source を登録:

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

一覧 / 削除:

```sh
curl -s "$A/grpc/descriptors" | jq .
curl -s -X DELETE "$A/grpc/descriptors/<descriptor-id>" | jq .
```

descriptor set binary の場合は `format: "descriptor_set"`、`content` に FileDescriptorSet bytes の base64 を渡します。

## 11. Masking

現在の mask 設定:

```sh
curl -s "$A/logging/mask" | jq .
```

置き換え:

```sh
curl -s -X PUT "$A/logging/mask" \
  -H 'content-type: application/json' \
  -d '{
    "headers": ["authorization", "cookie", "set-cookie", "x-api-key", "x-secret"],
    "jsonPaths": ["$.password", "$.token", "$.credentials.*"]
  }' | jq .
```

変更は on-memory です。再起動すると config の `logging.mask` に戻ります。

## 12. 推奨ワークフロー

1. capture rule を登録します。
2. app から対象 traffic を発生させます。
3. `GET /logs` と body preview/body download で対象 log を確認します。
4. `rules:simulate` で draft rule を保存済み log または sample request に当てます。
5. `rules:validate` で validation を通します。
6. `POST /rules` で rule を hot load します。
7. app の挙動、`/rules/:id/state`、`/logs`、`/metrics` を確認します。
8. 使い終わった rule は delete または disable-all し、必要なら export します。

## 13. Kubernetes での注意

morpheus コンテナ内の busybox `wget` は DELETE を扱えない場合があります。DELETE や複雑な body は port-forward した手元の `curl` を使うか、コンテナ内の Node.js fetch を使います。

```sh
kubectl --context=<context> -n <namespace> exec <pod> -c morpheus-proxy -- \
  node -e "fetch('http://localhost:18081/_morpheus/api/v1/rules/ID',{method:'DELETE'}).then(async r=>console.log(r.status, await r.text()))"
```

CONNECT egress listener を使う場合、app 側の下流アドレスは変えず、`GRPC_PROXY_ADDR=127.0.0.1:<connect-port>` のような client proxy 設定だけを足します。外部 TLS client を process 全体の proxy に巻き込まないよう、専用 env / dialer を推奨します。
