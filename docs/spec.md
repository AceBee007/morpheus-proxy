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
- sandbox なしで script rule を実行することはスコープ外とする
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
| `tcp` | raw TCP forward | connection metadata のみ。L7 rule は適用不可 |

HTTP / gRPC の payload を inspect / modify するには、proxy が L7 protocol を解釈できる listener を使う必要がある。
L7 rule は `http` / `http2` / `grpc` listener に限定する。`connect` / `tcp` listener では connection metadata と header 相当の情報だけを扱い、payload の matcher / manipulator は適用しない。

## 4. Core Specification

### 4.1 デフォルト転送

- ルール未設定時は、受け取った request を upstream にそのまま転送し、upstream response をそのまま client に返す
- capture / intercepted traffic の request / response metadata はログ保存対象である
- body payload は capture 用 matcher に一致した、または intercept / manipulation された traffic だけ保存する
- unmatched passthrough traffic は traffic log に保存しない
- proxy が protocol を解釈できない場合は connection metadata を保存し、payload body は保存しない
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
- script sandbox の状態

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
POST   /_morpheus/api/v1/rules:simulate
POST   /_morpheus/api/v1/rules:export
POST   /_morpheus/api/v1/rules:import
```

要件:

- rule の登録・削除・更新は hot load され、プロセス再起動を必要としない
- rule update は atomic に行う
- validation に失敗した rule は反映しない
- rule set には単調増加する `revision` を付与する
- update API は `expectedRevision` を受け取り、古い UI からの上書きを防ぐ
- `expectedRevision` が現在の rule revision と一致しない場合は `409 Conflict` を返し、client に rule reload を促す
- `DELETE` は既定では logical delete ではなく即時削除とする
- 一時停止したい場合は `enabled: false` に更新する

`rules:simulate`:

- 既存 traffic log に対して現在の rule set、または編集中の rule draft を適用した場合の結果を返す
- request body / response body を使った simulation には、事前に capture 用 matcher を設定して対象 traffic を logging しておく必要がある
- counter は消費しない
- upstream には送信しない
- response body は実際には変更せず、どの matcher が一致し、どの action が選択され、どの field が変更されるかを返す
- script matcher / manipulator は sandbox 内で実行し、error / timeout は simulation result と application log に記録する

Simulation request 例:

```json
{
  "logIds": ["2026-06-10T00-00-00.000Z-000001"],
  "ruleDraft": {
    "id": "draft-rule",
    "enabled": true,
    "priority": 100,
    "protocol": "http",
    "phase": "response",
    "match": {
      "type": "regex",
      "field": "path",
      "pattern": "^/users"
    },
    "action": {
      "type": "response_replace",
      "target": "body",
      "from": "real",
      "to": "mock"
    }
  },
  "options": {
    "includeBodyDiff": true
  }
}
```

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
`GET /logs/:id/request` と `GET /logs/:id/response` は body log policy により body が保存されている場合だけ payload を返す。body が保存されていない場合は metadata と `bodyLogged: false` / `bodyLoggingSkippedReason` を返す。

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
    "limit": 3,
    "afterExhausted": "passthrough"
  },
  "logging": {
    "capture": false
  },
  "createdAt": "2026-06-10T00:00:00.000Z",
  "updatedAt": "2026-06-10T00:00:00.000Z"
}
```

`logging.capture` は通信を変更せずに対象 traffic の body を保存したい場合に使う。通常は `action.type: "passthrough"` と組み合わせ、rule 追加前の simulation 用 log を収集する。

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
- HTTP binary body は既定では base64 文字列に対して match する
- gzip など圧縮 body は `decodeBody: true` の listener でのみ展開して match する
- gRPC message body は descriptor が登録されていれば JSON 化した message に match できる
- gRPC message body は descriptor がない場合、matcher / manipulator / UI preview の対象にしない

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

- script matcher / manipulator は初期仕様からサポートする
- script は proxy 本体とは別の sandbox subprocess で実行する
- sandbox では `fs` / `net` / `process` / filesystem access / dynamic import を禁止する
- 1 回の実行 timeout は既定 5 分とする
- script の compile error / runtime error / timeout は rule execution failure として traffic log と application log の両方に残す
- script error / timeout が発生した場合、その rule は request / response を編集せず passthrough する
- script timeout または freeze を検知した場合、該当 sandbox subprocess を停止し、新しい sandbox subprocess を起動する
- app 側では script の CPU / memory 上限は設けず、必要に応じて実行環境側で制御する
- script source は log と export に含まれるため、secret を埋め込まない

### 4.5 Actions

#### 4.5.1 Passthrough

```json
{
  "type": "passthrough"
}
```

明示的に何もしない。rule の match 計測や simulation 目的で使う。

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

gRPC mock response は descriptor がある場合のみ JSON mapping または textproto を protobuf binary に encode する。descriptor がない場合、body を伴う mock response は登録不可とし、`grpc-status` / `grpc-message` のみを返す fault injection に限定する。

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
    "limit": 3,
    "afterExhausted": "passthrough"
  }
}
```

Consume state:

- 消費 counter は `rule.id` ごとに同一 process 内で管理する
- 同じ fault injection を並列テストで分離したい場合、ユーザは matcher 側で test id や header value を条件に含め、別 rule として定義する
- proxy は `rule.id` 以外の per-user / per-header counter key は初期仕様では提供しない
- `consume` が未指定の場合は消費しない。matcher に一致するたびに action を実行する
- counter は rule update / delete / state reset で初期化できる
- counter の check / decrement は `rule.id` ごとの短い critical section で行う
- upstream 転送、response 待ち、script 実行中は consume lock を保持しない
- 初期仕様は single process 前提とし、multi-process / multi-instance 間の counter 同期は行わない

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

初期実装では unary を優先する。streaming request / response は body の buffering と message rewrite が難しいため、原則 passthrough する。ただし HTTP/2 header / gRPC metadata / trailer は streaming でも inspect / edit できる。

gRPC body の表示、matcher、mock body 生成、manipulation は descriptor または `.proto` が提供されている場合のみ許可する。descriptor がない場合、proxy は protobuf binary を decode / encode できないため、body を UI に表示せず、body matcher / body manipulator / JSON mock response を許可しない。

gRPC method が unary か streaming かの正確な判定も descriptor に依存する。descriptor がない場合は `content-type: application/grpc` と `:path` だけでは streaming 判定できないため、body を変更せず passthrough する。

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

gRPC body を JSON として matcher / manipulator に渡すには descriptor または `.proto` が必要である。

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

登録時 validation:

- `.proto` syntax を検証する
- service / method / request message / response message の対応を検証する
- gRPC mock response や message body を伴う fault injection では、指定された field values を対象 message schema に対して validation する
- validation に失敗した descriptor または gRPC body rule は登録しない

gRPC mock / fault body の指定形式:

- descriptor がある場合は JSON mapping または textproto で指定できる
- descriptor がない場合、body を伴う mock / fault は登録不可とする
- descriptor がない場合でも、`grpc-status` / `grpc-message` だけを返す fault injection は登録できる

descriptor がない場合:

- metadata / path / grpc-status / grpc-message は扱える
- body は decode / encode / logging / UI preview の対象にしない
- JSON message matching / manipulation は不可
- proto decode / encode error が発生した場合、traffic log と application log の両方に記録し、当該 request / response は body を編集せず passthrough する

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

#### 4.8.3 Body buffering limit

Body matcher / body manipulator / body logging が必要な場合だけ body を buffer する。単純な header / path matcher や passthrough では body を buffer しない。

既定値:

- request body buffer limit: 1 MiB
- response body buffer limit: 1 MiB
- 設定名: `MAX_REQUEST_BODY_BUFFER_BYTES` / `MAX_RESPONSE_BODY_BUFFER_BYTES`

Size 判定:

- HTTP/1.1 / HTTP/2 の `content-length` が存在し、limit を超える場合は body を読み込まず拒否する
- `content-length` が存在しない場合、読み込みながら byte 数を加算し、limit 超過時点で拒否する
- HTTP request body limit 超過時は `413 Payload Too Large` を返す
- gRPC message / body limit 超過時は `grpc-status: 8 RESOURCE_EXHAUSTED` を返す
- response phase の manipulation で upstream response が limit を超えた場合、その response は改変せず passthrough し、limit exceeded event を log に残す

Streaming:

- HTTP streaming と判定できる request / response は body を buffer せず passthrough する
- gRPC streaming は descriptor によって streaming method と判定できる場合、body を buffer せず passthrough する
- streaming traffic でも header / metadata / trailer の inspect / edit は許可する
- streaming traffic に body matcher / body manipulator rule が設定された場合、その rule は validation warning または execution skip として扱い、body は変更しない

### 4.9 Logging

Logging は traffic log と application log を分ける。

Traffic log:

- proxy を通過した request / response の metadata を記録する
- capture 用 matcher に一致した、または intercept / manipulation された request / response の body を記録する
- fault injection で生成した response を記録する
- passthrough だけの unmatched traffic は traffic log に保存しない

Traffic capture workflow:

1. まず capture 用 matcher rule を登録する
2. capture rule に match した request / response は通信を変更せず passthrough し、body log policy に従って body を保存する
3. 保存された traffic log に対して `rules:simulate` を実行し、追加予定の rule がどう match / manipulate するか確認する
4. simulation 結果を確認してから、本番の fault / mock / manipulation rule を登録する

Capture rule は `action.type: "passthrough"` と `logging.capture: true` を持つ通常 rule として表現する。
Capture rule は non-terminal として扱い、後続 rule の評価を止めない。

```json
{
  "id": "capture-users",
  "enabled": true,
  "priority": 10,
  "protocol": "http",
  "phase": "both",
  "match": {
    "type": "regex",
    "field": "path",
    "pattern": "^/users"
  },
  "action": {
    "type": "passthrough"
  },
  "logging": {
    "capture": true
  }
}
```

Application log:

- proxy process の起動・停止
- listener lifecycle
- admin API error
- rule validation error
- script compile / runtime / timeout error
- gRPC descriptor validation error
- protobuf decode / encode error
- log retention error

Traffic log と application log は別々の sink / file / directory に保存する。片方の retention や redaction 設定がもう片方に影響しないようにする。

#### 4.9.1 Log event model

Traffic log entry は capture / intercepted / fault / mock / manipulated traffic に対して作成する。unmatched passthrough traffic は traffic log に保存しない。

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
    "bodyLogged": true,
    "bodyPreview": "{}",
    "bodyPath": "logs/...request.bin"
  },
  "forwardedRequest": {
    "modified": false
  },
  "upstreamResponse": {
    "received": false
  },
  "response": {
    "statusCode": 200,
    "grpcStatus": 14,
    "headers": {},
    "bodyLogged": true,
    "bodyPreview": "",
    "bodyPath": "logs/...response.bin"
  },
  "outcome": "fault",
  "loggingReason": "matched_rule",
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

- traffic metadata for capture / intercepted / fault / mock / manipulated traffic
- matched rule 一覧
- applied action 一覧
- `logging.capture: true` の rule に一致した original request / returned response
- intercept / manipulation された original request
- request rewrite 後の forwarded request
- response phase rule に一致した upstream response
- client に返した returned response
- fault injection で生成した response
- request / response manipulation 前後の差分
- proxy internal error
- upstream error
- script error / timeout
- gRPC decode / encode error
- timing breakdown

#### 4.9.3 Body log policy

- unmatched passthrough traffic は traffic log に保存しない
- `logging.capture: true` の rule に一致した HTTP request / response は raw body を file に保存する
- intercept / manipulation された HTTP request / response は raw body を file に保存する
- matcher に一致しても `logging.capture: true` がなく、action が passthrough の場合、body は保存しない
- request rewrite が行われた場合は original request body と forwarded request body を保存する
- response manipulation が行われた場合は upstream response body と returned response body を保存する
- fault injection / mock response は生成した response body を保存する
- gRPC は descriptor がある場合のみ、`logging.capture: true` の rule に一致した、または intercept / manipulation された message の decode 後 JSON/text representation を保存する
- gRPC は descriptor がない場合、metadata / path / grpc-status / grpc-message のみ保存し、body は保存しない
- 管理 API の一覧では preview のみ返す
- 既定 preview size は 4KB
- body capture limit は body buffering limit と同じ値を使う
- limit を超えた場合は body を保存せず `bodyLoggingSkippedReason: "limit_exceeded"` を記録する
- binary body は HTTP の raw file として保存できるが、UI preview では base64 preview または hex preview とする

#### 4.9.4 Retention

設定:

- `TRAFFIC_LOG_DIR`
- `APP_LOG_DIR`
- `TRAFFIC_LOG_MAX_ENTRIES`
- `TRAFFIC_LOG_MAX_BYTES`
- `TRAFFIC_LOG_RETENTION_MS`
- `APP_LOG_RETENTION_MS`

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

Redaction は header と JSON body path に適用できる。HTTP raw body file は完全な redaction が難しいため、保存対象を capture/intercepted traffic に限定する。

Mask 設定は起動 config の JSONC で定義する。

```jsonc
{
  "logging": {
    "mask": {
      "headers": ["authorization", "cookie", "set-cookie", "x-api-key"],
      "jsonPaths": ["$.password", "$.token", "$.credentials.*"]
    }
  }
}
```

Mask は traffic log の metadata、header、HTTP JSON body preview、gRPC decoded body に適用する。HTTP raw body file は完全な redaction が難しいため、capture/intercepted body のみ保存する方針で leak surface を小さくする。

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

アプリ設定の主ソースは JSONC config file とする。JSONC を採用する理由は、テスト用設定でコメントを残しながら JSON schema validation できるようにするためである。

Config 読み込み要件:

- config file path は CLI option または `MORPHEUS_CONFIG` で指定する
- config file が存在しない、読めない、JSONC parse に失敗する、schema validation に失敗する、参照 descriptor file が読めない場合、app は起動に失敗する
- 起動失敗時は application log と stderr に理由を出し、non-zero exit code で終了する
- config 読み込み前に `appLogDir` が確定していない場合、stderr を authoritative な失敗出力とし、application log への書き込みは best effort とする
- env var は config path、admin token などの secret / deployment-specific override に限定する
- env override 後の最終 config も schema validation し、失敗した場合は起動しない

```jsonc
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
      "upstream": "http://127.0.0.1:8080",
      "maxRequestBodyBufferBytes": 1048576,
      "maxResponseBodyBufferBytes": 1048576
    },
    {
      "name": "grpc",
      "protocol": "grpc",
      "host": "0.0.0.0",
      "port": 15051,
      "upstream": "h2c://127.0.0.1:50051",
      // Descriptor files are required for gRPC body decode/edit.
      "descriptors": [],
      "maxRequestBodyBufferBytes": 1048576,
      "maxResponseBodyBufferBytes": 1048576
    }
  ],
  "rules": {
    "store": "memory"
  },
  "script": {
    "sandbox": "subprocess",
    "timeoutMs": 300000
  },
  "logging": {
    "trafficLogDir": "logs/morpheus-proxy/traffic",
    "appLogDir": "logs/morpheus-proxy/app",
    "trafficMaxEntries": 1000,
    "trafficMaxBytes": 104857600,
    "trafficRetentionMs": 86400000,
    "appRetentionMs": 86400000,
    "mask": {
      "headers": ["authorization", "cookie", "set-cookie", "x-api-key"],
      "jsonPaths": ["$.password", "$.token", "$.credentials.*"]
    }
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
| Settings | log retention、redaction、script sandbox 状態、admin token 状態 |

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
- rule revision

操作:

- create
- duplicate
- edit
- delete
- enable / disable
- reset consume state
- export selected rules
- import rules

UI は rule 更新時に現在表示している `revision` を `expectedRevision` として送る。server 側の revision と一致しない場合、UI は保存を拒否されたことを表示し、最新 rule set の reload を促す。

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

複合 matcher、pipeline action、rule-id based consume を JSON editor で編集する。

機能:

- JSON schema validation
- format
- validation API 実行
- sample request に対する test match
- 既存 log に対する `rules:simulate` 実行

#### 5.4.3 Script mode

Script matcher / manipulator を code editor で編集する。

機能:

- syntax highlight
- timeout warning
- available `ctx` type の表示
- sample context で simulation
- 既存 log に対する simulation
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
- 保存されている場合のみ raw request / response download
- この log から matcher を生成
- 現在の rule set または編集中 rule draft をこの log に適用した場合の simulation 結果

#### 5.5.3 Realtime

SSE または WebSocket で新規 log を streaming 表示する。UI は pause/resume を持ち、pause 中も server side の log は保持される。

### 5.6 Manual matcher / manipulator 登録

UI は script matcher / manipulator を登録できる。ただし以下を必須とする。

- 保存前に validation API を実行
- sample context で simulation 可能
- 既存 log に対する simulation が可能
- script sandbox の状態、実行 timeout、body size limit を表示
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
- log から matcher を生成する
- 既存 log に rule を適用した場合の simulation
- curl / grpcurl command の生成
- import / export
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

- log から matcher を生成
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
  "trigger": {
    "type": "probability",
    "rate": 0.1,
    "seed": "test-run-001"
  }
}
```

ただし deterministic なテストでは再現性が落ちるため、seed 指定を必須にする。

### 6.6 Deferred: CI integration

CI integration は初期仕様では扱わない。将来必要になった場合は以下を検討する。

- config file から起動時 rule load
- admin API で readiness 待ち
- JUnit-like fault report export
- exit 時 log archive
- Docker image

### 6.7 Security posture

管理 API と script rule は強力なので、初期仕様でも以下を明文化する。

- admin bind host は既定 `127.0.0.1`
- auth token を env var で設定可能
- script rule は初期仕様から許可するが、必ず sandbox subprocess で実行する
- remote admin access では auth required
- CORS disabled
- body logging は capture/intercepted traffic に限定し、mask 設定を JSONC config で定義する

## 7. 実装優先度案

### 7.1 Milestone 1: Core minimum

- 管理 API base path
- rule CRUD with hot load
- HTTP request phase regex matcher
- HTTP mock response / fault response
- 消費型 fault injection
- traffic metadata log と capture/intercepted body log 保存
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

- gRPC streaming metadata / trailer inspect
- streaming header / metadata edit
- streaming body passthrough の安定化
- retention manager
- metrics
- performance limits

## 8. Acceptance Criteria

- ルール未設定時、HTTP request は upstream に透過転送される
- ルール未設定時、gRPC request は upstream に透過転送される
- 管理 API から rule を登録すると、再起動なしで次 request から反映される
- 管理 API から rule を削除すると、次 request から反映されなくなる
- JSONC config の読み込み、parse、schema validation、descriptor 参照に失敗した場合、app は起動しない
- HTTP path regex rule で mock response を返せる
- HTTP response body の文字列置換 rule を設定できる
- gRPC method matcher で grpc-status fault を返せる
- 消費型 fault injection で最初の N 回だけ fault を返し、その後 passthrough できる
- unmatched passthrough traffic は traffic log に保存されない
- capture / intercepted traffic の request と returned response は body log policy に従って保存される
- fault injection で生成した response も log に保存される
- response manipulation された場合、upstream response と returned response が保存される
- gRPC body log / body manipulation は descriptor または `.proto` がある場合だけ許可される
- script error / timeout 時は req/resp を編集せず passthrough し、traffic log と application log に記録される
- 管理 API で rule 一覧、rule state、log 一覧、log 詳細を確認できる
- capture 用 matcher rule で対象 traffic を passthrough しながら body logging できる
- 管理 API で既存 log に rule を適用した場合の simulation を確認できる
- body を使った simulation は capture 済み log を入力にして実行できる
- UI で rule 一覧、log 一覧、manual matcher / manipulator 登録ができる
- UI で revision conflict を検知し、古い rule set をベースにした保存を拒否できる

## 9. 未決定事項

- 管理 API を proxy listener 上でも常に公開するか、管理用ポート限定にするか
- TLS 終端を初期実装に含めるか
- gRPC streaming manipulation をどの milestone で扱うか
- script sandbox にどの runtime を使うか
- rule 永続化を初期実装に含めるか
- UI を同一 Node.js process で配信するか、別 build artifact とするか
