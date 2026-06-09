# morpheus-proxy Specification

## 1. 目的

`morpheus-proxy` は、テスト環境で HTTP / gRPC トラフィックを透過的に転送しながら、リクエストとレスポンスを inspect、intercept、変更、mock、fault injection できるプロキシである。

主な用途は以下とする。

- サービス間通信の実リクエストと実レスポンスを観測する
- 特定条件のリクエストに対して upstream に転送せず mock response を返す
- upstream response を受け取った後に response の一部を変更して返す
- 一定回数だけ失敗させ、その後は正常系へ戻すような消費型 fault injection を行う
- テスト中に管理 API / Web UI からルールを hot load し、プロセス再起動なしで挙動を変える

## 2. スコープ

### 2.1 Core 機能

Core はプロキシとしての通信処理、ルール評価、fault injection、response manipulation、ログ保存、管理 API を担当する。

### 2.2 UI 機能

UI は管理用 Web front として、既存ルールの確認、ルール登録・更新・削除、ログ確認、手動 matcher / manipulator の登録、リアルタイム監視を担当する。

### 2.3 明示的な非目標

- 本番 traffic shaping 基盤としての高可用性運用は初期スコープ外とする
- セキュリティ境界をまたぐ untrusted user からの script rule 実行は初期スコープ外とする
- HTTPS / TLS traffic の完全な payload inspect は、TLS 終端または MITM 設定なしではサポートしない
- gRPC の全メッセージ型を descriptor なしで意味的に decode することはできない

## 3. 全体構成

### 3.1 Data plane

Data plane は受け取った proxy traffic を処理する。

- HTTP/1.1 request / response
- HTTP/2 request / response
- gRPC unary / streaming
- TCP passthrough / CONNECT traffic

Data plane のデフォルト動作は「何もしないで透過転送」である。ルールが一致した場合だけ、mock、fault injection、delay、drop、response manipulation などを行う。

### 3.2 Control plane

Control plane は管理 API と Web UI を提供する。

- 既定の管理 base path は `/_morpheus`
- 管理 API は `/_morpheus/api/v1/*`
- Web UI は `/_morpheus/`
- health endpoint は `/_morpheus/healthz`

管理 API は管理用ポートで公開する。HTTP proxy listener でも同じ base path を有効化できるが、安全のため初期設定では管理用ポートのみで公開する。

### 3.3 Listener モード

| モード | 用途 | inspect / intercept |
| --- | --- | --- |
| `http` | HTTP/1.1 reverse proxy | header/path/body/response の inspect と変更が可能 |
| `http2` | HTTP/2 reverse proxy | header/path/body/response の inspect と変更が可能 |
| `grpc` | gRPC over HTTP/2 | metadata/path/message/trailer/grpc-status の inspect と変更が可能 |
| `connect` | HTTP CONNECT proxy | CONNECT request の inspect は可能。encrypted payload は byte log のみ |
| `tcp` | raw TCP forward | L4 byte log のみ。L7 rule は適用不可 |

HTTP / gRPC の payload を inspect / modify するには、proxy が L7 protocol を解釈できる listener を使う必要がある。

## 4. Core Specification

### 4.1 デフォルト転送

- ルール未設定時は、受け取った request を upstream にそのまま転送し、upstream response をそのまま client に返す
- request / response はログ保存対象である
- proxy が protocol を解釈できない場合でも、raw byte log と connection metadata は保存する
- 透過転送時も trace id / request id を生成または継承し、ログと response metadata に関連付ける

### 4.2 管理 API

管理 API は JSON over HTTP とする。base path は `/_morpheus/api/v1` とする。

#### 4.2.1 Health

```text
GET /_morpheus/healthz
GET /_morpheus/api/v1/status
```

`status` は以下を返す。

- process uptime
- active listener 一覧
- active connection 数
- rule revision
- rule count
- log retention 設定
- script rule が有効かどうか

#### 4.2.2 Rule CRUD

```text
GET    /_morpheus/api/v1/rules
POST   /_morpheus/api/v1/rules
GET    /_morpheus/api/v1/rules/:id
PUT    /_morpheus/api/v1/rules/:id
PATCH  /_morpheus/api/v1/rules/:id
DELETE /_morpheus/api/v1/rules/:id
POST   /_morpheus/api/v1/rules:replace
POST   /_morpheus/api/v1/rules:validate
POST   /_morpheus/api/v1/rules:export
POST   /_morpheus/api/v1/rules:import
```

要件:

- rule の登録・削除・更新は hot load され、プロセス再起動を必要としない
- rule update は atomic に行う
- validation に失敗した rule は反映しない
- rule set には単調増加する `revision` を付与する
- update API は optional で `expectedRevision` を受け取り、古い UI からの上書きを防ぐ
- `DELETE` は既定では logical delete ではなく即時削除とする
- 一時停止したい場合は `enabled: false` に更新する

#### 4.2.3 Rule state

```text
GET  /_morpheus/api/v1/rules/:id/state
POST /_morpheus/api/v1/rules/:id/state:reset
```

消費型 fault injection の残回数、hit count、last matched timestamp などを確認・reset する。

#### 4.2.4 Log API

```text
GET    /_morpheus/api/v1/logs
GET    /_morpheus/api/v1/logs/:id
GET    /_morpheus/api/v1/logs/:id/request
GET    /_morpheus/api/v1/logs/:id/response
GET    /_morpheus/api/v1/logs/:id/events
DELETE /_morpheus/api/v1/logs
```

`GET /logs` は filter / pagination をサポートする。

Filter 例:

- `protocol=http|grpc|tcp`
- `method=GET`
- `path=/api/users`
- `grpcService=demo.TimeService`
- `grpcMethod=Now`
- `ruleId=...`
- `outcome=passthrough|mock|fault|modified|dropped|upstream_error`
- `from` / `to`
- `statusCode`
- `grpcStatus`
- `contains`

`/events` は SSE または WebSocket でリアルタイム log event を配信する。

#### 4.2.5 Replay API

テスト用途では記録した request を再送したいケースが多いため、以下を提案機能として定義する。

```text
POST /_morpheus/api/v1/logs/:id:replay
```

Replay は default disabled とし、明示的に `ENABLE_REPLAY=true` の場合のみ有効化する。再送先は元の upstream または request body で指定された override target とする。

### 4.3 Rule model

Rule は以下の JSON model で表現する。

```json
{
  "id": "rule-503-three-times",
  "name": "Return 503 for first three user requests",
  "description": "Fault injection for retry test",
  "enabled": true,
  "priority": 100,
  "protocol": "http",
  "phase": "request",
  "match": {
    "type": "regex",
    "field": "path",
    "pattern": "^/users/.*"
  },
  "action": {
    "type": "fault",
    "fault": {
      "kind": "http_response",
      "statusCode": 503,
      "headers": {
        "content-type": "application/json"
      },
      "body": "{\"error\":\"temporary unavailable\"}"
    }
  },
  "consume": {
    "mode": "global",
    "limit": 3,
    "afterExhausted": "passthrough"
  },
  "createdAt": "2026-06-10T00:00:00.000Z",
  "updatedAt": "2026-06-10T00:00:00.000Z"
}
```

#### 4.3.1 Rule ordering

- `enabled: false` の rule は評価しない
- `priority` が大きい rule を先に評価する
- priority が同じ場合は `updatedAt` が古い rule を先に評価する
- 初期仕様では最初に一致した terminal action を実行する
- 複数 action を連鎖させる場合は `action.type: "pipeline"` を使う

#### 4.3.2 Rule phase

| phase | 意味 |
| --- | --- |
| `request` | upstream に転送する前に評価する。mock / fault / drop / delay / request rewrite が可能 |
| `response` | upstream response を受け取った後に評価する。response rewrite / response fault が可能 |
| `both` | request と response の両方を評価する |

Mock response と connection drop は request phase で完結し、upstream へ転送しない。

### 4.4 Matcher

Matcher は簡易 matcher と script matcher の 2 種類をサポートする。

#### 4.4.1 簡易 regex matcher

単一 field に対して正規表現で match する。

```json
{
  "type": "regex",
  "field": "path",
  "pattern": "^/api/users/\\d+$",
  "flags": "i"
}
```

対応 field:

| field | HTTP | gRPC | 備考 |
| --- | --- | --- | --- |
| `method` | yes | no | HTTP method |
| `scheme` | yes | yes | `http` / `https` |
| `host` | yes | yes | Host または `:authority` |
| `path` | yes | yes | HTTP path または gRPC `:path` |
| `query` | yes | no | query string |
| `header.<name>` | yes | yes | HTTP header / gRPC metadata |
| `body` | yes | limited | text / json / decoded gRPC message |
| `rawBodyBase64` | yes | yes | binary payload |
| `grpc.service` | no | yes | `/package.Service/Method` から抽出 |
| `grpc.method` | no | yes | `/package.Service/Method` から抽出 |
| `grpc.status` | no | yes | response phase のみ |

制約:

- body matching は capture limit 内の payload のみ対象とする
- binary body は既定では base64 文字列に対して match する
- gzip など圧縮 body は `decodeBody: true` の listener でのみ展開して match する
- gRPC message body は descriptor が登録されていれば JSON 化した message に match できる

#### 4.4.2 複合 matcher

簡易 matcher を組み合わせる必要がある場合は `all` / `any` / `not` を使う。

```json
{
  "type": "all",
  "conditions": [
    {
      "type": "regex",
      "field": "path",
      "pattern": "^/orders"
    },
    {
      "type": "regex",
      "field": "header.x-test-case",
      "pattern": "^retry-"
    }
  ]
}
```

この複合 matcher は UI で組み立てやすいようにするが、複雑すぎる条件は script matcher に寄せる。

#### 4.4.3 Script matcher

完全に手動の matcher 関数を登録できる。

```json
{
  "type": "script",
  "language": "javascript",
  "source": "return ctx.request.path.startsWith('/users') && ctx.request.headers['x-test'] === '1';"
}
```

関数 signature:

```ts
type Matcher = (ctx: MatchContext) => boolean | Promise<boolean>;
```

`MatchContext`:

```ts
type MatchContext = {
  protocol: 'http' | 'grpc' | 'tcp';
  phase: 'request' | 'response';
  request: {
    id: string;
    method?: string;
    scheme?: string;
    host?: string;
    path?: string;
    query?: string;
    headers: Record<string, string | string[]>;
    body?: string;
    rawBodyBase64?: string;
    grpc?: {
      service?: string;
      method?: string;
      metadata: Record<string, string | string[]>;
      messages?: unknown[];
    };
  };
  response?: {
    statusCode?: number;
    headers: Record<string, string | string[]>;
    body?: string;
    rawBodyBase64?: string;
    grpc?: {
      status?: number;
      message?: string;
      trailers: Record<string, string | string[]>;
      messages?: unknown[];
    };
  };
  ruleState: {
    hits: number;
    remaining?: number;
  };
};
```

Security:

- script matcher / manipulator は `ALLOW_SCRIPT_RULES=true` の場合のみ有効化する
- script は sandbox 内で実行し、`fs` / `net` / `process` / filesystem access を禁止する
- 1 回の実行 timeout は既定 50ms とする
- script の compile error / runtime error は rule validation failure または rule execution failure として log に残す
- script source は log と export に含まれるため、secret を埋め込まない

### 4.5 Actions

#### 4.5.1 Passthrough

```json
{
  "type": "passthrough"
}
```

明示的に何もしない。rule の dry-run や hit count 目的で使う。

#### 4.5.2 Delay

```json
{
  "type": "delay",
  "durationMs": 500
}
```

request phase では upstream 転送前に遅延する。response phase では client 返却前に遅延する。

#### 4.5.3 Fault

HTTP fault:

```json
{
  "type": "fault",
  "fault": {
    "kind": "http_response",
    "statusCode": 500,
    "headers": {
      "content-type": "application/json"
    },
    "body": "{\"error\":\"injected\"}"
  }
}
```

gRPC fault:

```json
{
  "type": "fault",
  "fault": {
    "kind": "grpc_status",
    "status": 14,
    "message": "injected unavailable",
    "metadata": {
      "x-morpheus-fault": "true"
    }
  }
}
```

Connection fault:

```json
{
  "type": "fault",
  "fault": {
    "kind": "connection",
    "mode": "reset"
  }
}
```

Fault kind:

| kind | HTTP | gRPC | 説明 |
| --- | --- | --- | --- |
| `http_response` | yes | no | upstream に転送せず指定 HTTP response を返す |
| `grpc_status` | no | yes | upstream に転送せず指定 gRPC status を返す |
| `timeout` | yes | yes | upstream または client への返却を timeout させる |
| `connection` | yes | yes | connection close / reset |
| `latency` | yes | yes | delay action と同等だが fault として記録する |
| `bandwidth` | yes | limited | response を指定 rate で返す |

#### 4.5.4 Mock response

HTTP mock:

```json
{
  "type": "mock_response",
  "response": {
    "statusCode": 200,
    "headers": {
      "content-type": "application/json"
    },
    "body": "{\"name\":\"mock-user\"}"
  }
}
```

gRPC mock:

```json
{
  "type": "mock_response",
  "response": {
    "grpcStatus": 0,
    "grpcMessage": "",
    "messages": [
      {
        "name": "mock-user"
      }
    ],
    "metadata": {
      "x-morpheus-mock": "true"
    }
  }
}
```

gRPC mock response は descriptor がある場合は JSON message を protobuf binary に encode する。descriptor がない場合は `rawMessagesBase64` を指定する。

#### 4.5.5 Request rewrite

```json
{
  "type": "request_rewrite",
  "operations": [
    {
      "op": "set_header",
      "name": "x-test-case",
      "value": "retry"
    },
    {
      "op": "replace_body",
      "from": "old",
      "to": "new"
    }
  ]
}
```

Request rewrite は upstream に送る前に適用する。ログには original request と forwarded request の両方を保存する。

#### 4.5.6 Response replace

簡易 response manipulation として、文字列置換をサポートする。

```json
{
  "type": "response_replace",
  "from": "real-value",
  "to": "mock-value",
  "target": "body"
}
```

`target`:

- `body`
- `header.<name>`
- `grpc.message`
- `grpc.trailer.<name>`

Body replace は text body のみ既定有効。binary body や encoded gRPC message の置換は descriptor / encoding 設定が必要である。

#### 4.5.7 Script manipulator

元 request と元 response を受け取り、加工済み response を返す manipulator 関数を登録できる。

```json
{
  "type": "script_manipulator",
  "language": "javascript",
  "source": "ctx.response.body = ctx.response.body.replace('real', 'mock'); return ctx.response;"
}
```

関数 signature:

```ts
type ResponseManipulator = (
  ctx: ManipulatorContext
) => ResponsePatch | FullResponse | Promise<ResponsePatch | FullResponse>;
```

`ManipulatorContext`:

```ts
type ManipulatorContext = MatchContext & {
  upstream: {
    durationMs: number;
    error?: string;
  };
};
```

戻り値:

```ts
type ResponsePatch = {
  statusCode?: number;
  headers?: Record<string, string | string[] | null>;
  body?: string;
  rawBodyBase64?: string;
  grpcStatus?: number;
  grpcMessage?: string;
  grpcTrailers?: Record<string, string | string[] | null>;
  grpcMessages?: unknown[];
};
```

Security は script matcher と同じである。加えて、manipulator は body size limit を超えた response には既定では適用しない。

#### 4.5.8 Pipeline action

複数 action を順に適用する。

```json
{
  "type": "pipeline",
  "actions": [
    {
      "type": "delay",
      "durationMs": 200
    },
    {
      "type": "response_replace",
      "from": "real",
      "to": "mock",
      "target": "body"
    }
  ]
}
```

Pipeline 内で terminal action が発生した場合、それ以降の action は実行しない。

Terminal action:

- `mock_response`
- `fault` with `http_response`
- `fault` with `grpc_status`
- `fault` with `connection`
- `fault` with `timeout`

### 4.6 消費型 fault injection

消費型 fault injection は「最初の N 回だけ失敗し、その後は正常に戻る」などのテストに使う。

```json
{
  "consume": {
    "mode": "global",
    "limit": 3,
    "afterExhausted": "passthrough"
  }
}
```

Mode:

| mode | 説明 |
| --- | --- |
| `none` | 消費しない。毎回発火する |
| `global` | rule 全体で hit 数を共有する |
| `per_key` | 指定 key ごとに hit 数を持つ |

`per_key` 例:

```json
{
  "consume": {
    "mode": "per_key",
    "key": "header.x-user-id",
    "limit": 2,
    "afterExhausted": "passthrough"
  }
}
```

`afterExhausted`:

- `passthrough`: 以後は upstream に透過転送
- `disable_rule`: rule を自動的に `enabled: false` にする
- `next_rule`: 次に一致する rule を評価する

追加設定:

- `resetAfterMs`: 一定時間後に消費状態を reset
- `cooldownMs`: 発火後に一定時間発火させない
- `maxHitsPerWindow`: rolling window 内の最大発火回数

### 4.7 gRPC handling

#### 4.7.1 対応範囲

- unary request / unary response
- server streaming
- client streaming
- bidirectional streaming
- metadata / trailer capture
- grpc-status / grpc-message capture

初期実装では unary を優先し、streaming は inspect と fault injection を先にサポートする。streaming message の個別 rewrite は将来拡張として扱ってよい。

#### 4.7.2 Path parsing

gRPC path は以下として解釈する。

```text
/{package}.{Service}/{Method}
```

抽出値:

- `grpc.fullMethod`
- `grpc.package`
- `grpc.service`
- `grpc.method`

#### 4.7.3 Descriptor registry

gRPC body を JSON として matcher / manipulator に渡すには descriptor が必要である。

管理 API:

```text
GET    /_morpheus/api/v1/grpc/descriptors
POST   /_morpheus/api/v1/grpc/descriptors
DELETE /_morpheus/api/v1/grpc/descriptors/:id
```

登録形式:

- protobuf descriptor set binary
- `.proto` file set
- service mapping only

descriptor がない場合:

- metadata / path / raw message base64 は扱える
- mock response は `rawMessagesBase64` で指定する
- JSON message matching / manipulation は不可

#### 4.7.4 gRPC fault semantics

- gRPC application error は HTTP status `200` と trailer `grpc-status != 0` で返す
- transport error は connection close / reset として扱う
- delay は request header 受信後、message 受信後、response trailer 返却前のいずれかに指定できる

### 4.8 HTTP handling

#### 4.8.1 対応範囲

- HTTP/1.1
- HTTP/2
- request / response header
- query string
- text body
- JSON body
- binary body capture
- compressed body capture

#### 4.8.2 Body decoding

`decodeBody` が有効な listener では以下を decode する。

- `gzip`
- `deflate`
- `br`

Decode した body を matcher / manipulator に渡す場合、client に返す時は元 encoding に再 encode するか、`content-encoding` を削除して plain body として返す。どちらを採用したかは log に保存する。

### 4.9 Logging

#### 4.9.1 Log event model

すべての request は log entry を持つ。

```json
{
  "id": "2026-06-10T00-00-00.000Z-000001",
  "startedAt": "2026-06-10T00:00:00.000Z",
  "endedAt": "2026-06-10T00:00:00.120Z",
  "durationMs": 120,
  "protocol": "grpc",
  "listener": "inbound-grpc",
  "client": "127.0.0.1:53000",
  "target": "127.0.0.1:50051",
  "request": {
    "method": "POST",
    "path": "/demo.TimeService/Now",
    "headers": {},
    "bodyPreview": "{}",
    "bodyPath": "logs/...request.bin"
  },
  "response": {
    "statusCode": 200,
    "grpcStatus": 14,
    "headers": {},
    "bodyPreview": "",
    "bodyPath": "logs/...response.bin"
  },
  "outcome": "fault",
  "matchedRules": [
    {
      "id": "rule-grpc-unavailable",
      "action": "fault",
      "consumed": true,
      "remaining": 2
    }
  ]
}
```

#### 4.9.2 保存対象

- original request
- forwarded request
- upstream response
- returned response
- matched rule 一覧
- applied action 一覧
- fault injection で生成した response
- response manipulation 前後の差分
- proxy internal error
- upstream error
- timing breakdown

#### 4.9.3 Body log policy

- raw body は file に保存する
- 管理 API の一覧では preview のみ返す
- 既定 preview size は 4KB
- 既定 raw body capture limit は 1MB
- limit を超えた場合は truncated flag を立てる
- binary body は base64 preview または hex preview とする

#### 4.9.4 Retention

設定:

- `LOG_DIR`
- `LOG_MAX_ENTRIES`
- `LOG_MAX_BYTES`
- `LOG_RETENTION_MS`
- `LOG_BODY_CAPTURE_LIMIT_BYTES`

Retention 超過時は古い log から削除する。削除は metadata、request body、response body を一貫して扱う。

#### 4.9.5 Redaction

テスト用途でも credential が流れる可能性があるため、redaction をサポートする。

既定 redaction 対象:

- `authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `password`
- `token`

Redaction は header と JSON body path に適用できる。raw body file は既定では redact しないため、必要な環境では raw body capture を無効化する。

### 4.10 Hot load と永続化

#### 4.10.1 Hot load

- 管理 API で rule が更新されると、次の request から新 rule set を使う
- 処理中の request は開始時点の rule revision を使い続ける
- rule compilation は反映前に行う
- script matcher / manipulator も反映前に compile する

#### 4.10.2 永続化

初期仕様:

- rule は memory store
- process restart で rule は消える

提案仕様:

- `RULE_STORE=file` の場合、rule set を JSON file に保存する
- `RULE_STORE_PATH` で file path を指定する
- 起動時に保存済み rule を load する
- import / export API で test fixture として再利用できる

### 4.11 Safety and limits

以下は設定可能にする。

- max request body buffer bytes
- max response body buffer bytes
- max concurrent connections
- max active streams
- upstream timeout
- idle timeout
- script timeout
- log retention
- admin API authentication

管理 API は destructive な挙動を持つため、以下を推奨する。

- 既定では `127.0.0.1` に bind
- remote bind する場合は token authentication を要求
- UI から script rule を登録する場合は明示的な confirmation を要求
- CORS は既定 disabled

### 4.12 Observability

Core は以下を提供する。

- structured log
- metrics endpoint
- active connection count
- request count by outcome
- rule hit count
- upstream latency histogram
- fault injection count
- script error count

Metrics endpoint:

```text
GET /_morpheus/api/v1/metrics
```

Prometheus format は提案機能として `/_morpheus/metrics` でも提供できる。

### 4.13 Configuration

設定は env var と config file の両方をサポートする。

```json
{
  "admin": {
    "host": "127.0.0.1",
    "port": 18081,
    "basePath": "/_morpheus",
    "authToken": null
  },
  "listeners": [
    {
      "name": "http",
      "protocol": "http",
      "host": "0.0.0.0",
      "port": 18080,
      "upstream": "http://127.0.0.1:8080"
    },
    {
      "name": "grpc",
      "protocol": "grpc",
      "host": "0.0.0.0",
      "port": 15051,
      "upstream": "h2c://127.0.0.1:50051",
      "descriptors": []
    }
  ],
  "rules": {
    "store": "memory"
  },
  "logs": {
    "dir": "logs/morpheus-proxy",
    "maxEntries": 1000,
    "bodyCaptureLimitBytes": 1048576
  }
}
```

## 5. UI Specification

### 5.1 目的

UI は proxy の現在状態を可視化し、テスト中に素早く rule を作成・変更し、実 traffic と fault injection の結果を確認できる管理画面である。

### 5.2 画面構成

| 画面 | 機能 |
| --- | --- |
| Dashboard | listener 状態、request 数、fault 数、rule hit 数、最新 log |
| Rules | rule 一覧、検索、enable / disable、priority 変更、状態 reset |
| Rule Editor | matcher / action / consume 設定、script 編集、validation |
| Logs | request / response log 一覧、filter、詳細、diff、raw download |
| Replay | log からの request replay |
| gRPC Descriptors | descriptor 登録、service / method 確認 |
| Settings | log retention、redaction、script rule 有効状態、admin token 状態 |

### 5.3 Rules 画面

表示項目:

- enabled toggle
- priority
- name
- protocol
- phase
- matcher summary
- action summary
- hit count
- remaining count
- last matched
- validation status

操作:

- create
- duplicate
- edit
- delete
- enable / disable
- reset consume state
- export selected rules
- import rules

### 5.4 Rule Editor

Rule Editor は 3 つのモードを持つ。

#### 5.4.1 Simple mode

Regex matcher と built-in action をフォームで設定する。

入力:

- protocol
- phase
- match field
- regex pattern
- regex flags
- action type
- action arguments
- consume setting

#### 5.4.2 Advanced mode

複合 matcher、pipeline action、per-key consume を JSON editor で編集する。

機能:

- JSON schema validation
- format
- validation API 実行
- sample request に対する test match

#### 5.4.3 Script mode

Script matcher / manipulator を code editor で編集する。

機能:

- syntax highlight
- timeout warning
- available `ctx` type の表示
- sample context で dry-run
- dangerous operation の警告
- save 前 confirmation

### 5.5 Logs 画面

#### 5.5.1 Log list

Filter:

- protocol
- method
- path
- grpc service / method
- rule id
- outcome
- status code
- grpc status
- time range
- text search

表示:

- timestamp
- duration
- protocol
- method/path or gRPC method
- outcome
- status
- matched rule
- body size

#### 5.5.2 Log detail

詳細表示:

- request headers
- request body preview
- forwarded request diff
- upstream response headers
- upstream response body preview
- returned response diff
- gRPC metadata / trailers
- matched rule and action trace
- timing breakdown
- raw request / response download

#### 5.5.3 Realtime

SSE または WebSocket で新規 log を streaming 表示する。UI は pause/resume を持ち、pause 中も server side の log は保持される。

### 5.6 Manual matcher / manipulator 登録

UI は script matcher / manipulator を登録できる。ただし以下を必須とする。

- `ALLOW_SCRIPT_RULES=true` でない場合は UI 上で disabled 表示
- 保存前に validation API を実行
- sample context で dry-run 可能
- script の実行 timeout と body size limit を表示
- script source が export / log に残ることを明示する

### 5.7 UI で提案する補助機能

- rule template
  - HTTP 500 for first N requests
  - gRPC UNAVAILABLE for first N requests
  - delay response
  - replace response body string
  - mock JSON response
  - mock gRPC unary response
- one-click disable all rules
- rule hit timeline
- log から rule を作る
- log から mock response rule を作る
- curl / grpcurl command の生成
- import / export for CI fixtures
- dark / light theme は任意。初期は機能優先でよい

## 6. 追加で考慮すべき機能提案

### 6.1 Scenario mode

複数 rule と consume state をまとめた scenario を定義できると、E2E テストで扱いやすい。

```text
POST /_morpheus/api/v1/scenarios/:id:start
POST /_morpheus/api/v1/scenarios/:id:stop
POST /_morpheus/api/v1/scenarios/:id:reset
```

例:

- `checkout-retry-success`
- `payment-timeout`
- `grpc-upstream-unavailable-first-3`

### 6.2 Test isolation

並列テストで rule が衝突しないよう、test run id による namespace を導入する。

- request header `x-morpheus-test-id`
- query `morpheusTestId`
- rule namespace
- log namespace

### 6.3 Recording and replay

実 traffic を record し、後続テストで replay / mock 化する。

- log から mock rule を生成
- HAR-like export
- gRPC descriptor 付き export
- response fixture として保存

### 6.4 Contract-aware gRPC / JSON support

descriptor や JSON schema を登録できると、UI の body editor と validation が改善する。

- protobuf descriptor set
- OpenAPI schema
- JSON Schema

### 6.5 Failure distribution

固定回数だけでなく、確率的 fault injection もあると負荷試験に使いやすい。

```json
{
  "consume": {
    "mode": "probability",
    "rate": 0.1
  }
}
```

ただし deterministic なテストでは再現性が落ちるため、seed 指定を必須にする。

### 6.6 CI integration

CI から使いやすいように以下を提供する。

- config file から起動時 rule load
- admin API で readiness 待ち
- JUnit-like fault report export
- exit 時 log archive
- Docker image

### 6.7 Security posture

管理 API と script rule は強力なので、初期仕様でも以下を明文化する。

- admin bind host は既定 `127.0.0.1`
- auth token を env var で設定可能
- script rule は既定 disabled
- remote admin access では auth required
- CORS disabled
- raw body logging は secret leak risk がある

## 7. 実装優先度案

### 7.1 Milestone 1: Core minimum

- 管理 API base path
- rule CRUD with hot load
- HTTP request phase regex matcher
- HTTP mock response / fault response
- 消費型 fault injection
- request / response log 保存
- log API

### 7.2 Milestone 2: HTTP response manipulation

- response phase matcher
- `response_replace`
- request / upstream response / returned response の差分 log
- UI Rules / Logs minimum

### 7.3 Milestone 3: gRPC unary

- gRPC path / metadata matcher
- gRPC status fault
- gRPC unary mock response
- descriptor registry
- gRPC log detail

### 7.4 Milestone 4: Advanced controls

- script matcher
- script manipulator
- pipeline action
- scenario mode
- replay
- import / export

### 7.5 Milestone 5: Streaming and scale

- gRPC streaming inspect
- streaming fault injection
- retention manager
- metrics
- performance limits

## 8. Acceptance Criteria

- ルール未設定時、HTTP request は upstream に透過転送される
- ルール未設定時、gRPC request は upstream に透過転送される
- 管理 API から rule を登録すると、再起動なしで次 request から反映される
- 管理 API から rule を削除すると、次 request から反映されなくなる
- HTTP path regex rule で mock response を返せる
- HTTP response body の文字列置換 rule を設定できる
- gRPC method matcher で grpc-status fault を返せる
- 消費型 fault injection で最初の N 回だけ fault を返し、その後 passthrough できる
- request と returned response は log として保存される
- fault injection で生成した response も log に保存される
- passthrough された upstream response も log に保存される
- 管理 API で rule 一覧、rule state、log 一覧、log 詳細を確認できる
- UI で rule 一覧、log 一覧、manual matcher / manipulator 登録ができる

## 9. 未決定事項

- 管理 API を proxy listener 上でも常に公開するか、管理用ポート限定にするか
- TLS 終端を初期実装に含めるか
- gRPC streaming manipulation をどの milestone で扱うか
- script sandbox にどの runtime を使うか
- rule 永続化を初期実装に含めるか
- log raw body を既定有効にするか、preview のみにするか
- UI を同一 Node.js process で配信するか、別 build artifact とするか
