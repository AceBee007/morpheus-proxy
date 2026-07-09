# morpheus-proxy Specification

## 1. 目的

`morpheus-proxy` は、テスト環境(dev 環境)で HTTP / gRPC トラフィックを透過的に転送しながら、リクエストとレスポンスを inspect、intercept、変更、mock、fault injection できるプロキシである。

主な用途は以下とする。

- サービス間通信の実リクエストと実レスポンスを観測する
- 特定条件のリクエストに対して upstream に転送せず mock response を返す
- upstream response を受け取った後に response の一部を変更して返す
- 一定回数だけ失敗・改変し、その後は正常系へ戻す消費型 rule を適用する
- テスト中に管理 API / Web UI からルールを hot load し、プロセス再起動なしで挙動を変える

## 2. スコープ

### 2.1 Core 機能

Core はプロキシとしての通信処理、ルール評価、fault injection、request / response manipulation、ログ保存、管理 API を担当する。

### 2.2 UI 機能

UI は管理用 Web front として、既存ルールの確認、ルール登録・更新・削除、ログ確認、手動 matcher / manipulator の登録、リアルタイム監視を担当する。

UI と API の関係は以下の原則に従う。

- UI は管理 API のみを通じて操作を行う。UI 専用の隠し API は作らない
- UI でできる操作は必ず管理 API でもできる(API の機能集合は UI の機能集合を包含する)

### 2.3 明示的な非目標

- TLS 終端 / TLS origination。本 proxy はマイクロサービスと istio sidecar の間に配置される前提であり、TLS / mTLS は istio が担当する。proxy は plaintext(HTTP/1.1、h2c)のみを扱う
- 管理 API / UI の認証・認可。dev 環境での利用を前提とする。将来 remote 公開が必要になった時点で再検討する
- rule の永続化。rule / mask 設定は on-memory で保持し、プロセス再起動で失われる。import / export を代替手段として提供する
- gRPC streaming message body の manipulation(metadata / trailer / status の inspect / edit はサポートする)
- 記録済み request の再送(replay)
- opaque な TCP passthrough(中身を見ないバイト転送)。対象 protocol は HTTP と gRPC のみとする。
  なお、client の proxy 設定経由で outbound を傍受するための **inspecting な HTTP CONNECT tunnel** は
  listener `mode: "connect"` として初期仕様でサポートする(4.14)。CONNECT で受けたトンネル内の平文
  h2c / HTTP を inspect / manipulate してから転送するものであり、中身を見ない blind な passthrough は行わない
- scenario mode(複数 rule のセット切り替え)
- CI integration
- sandbox なしで script rule を実行すること
- 本番 traffic shaping 基盤としての高可用性運用
- 透過転送時のレイテンシオーバーヘッドの数値目標(dev 用途のため設けない)

## 3. 全体構成

### 3.1 技術スタック

- 実装言語: Node.js(LTS)+ TypeScript
- script sandbox: 実装言語と同じ Node.js runtime を使い、proxy 本体とは別の subprocess で実行する
- UI: React で実装し、build した静的 assets を SPA として admin server から配信する
- 管理 API: JSON over HTTP/1.1

### 3.2 デプロイモデル

本 proxy はマイクロサービス(以下 app)と同一 pod のサイドカーコンテナとして動かし、
istio sidecar(istio-proxy)と共存させる。TLS / mTLS の終端と暗号化は従来どおり
istio-proxy が行い、morpheus-proxy に到達する traffic は plaintext(HTTP/1.1 または h2c)である。

#### 主方式: CONNECT egress(app の outbound を傍受)

app が下流サービスへ出す request / 下流からの response を inspect / manipulate する。
既存のネットワーク設定(Service / targetPort / istio 設定 / 下流アドレス)は一切変えず、
app には client の proxy 設定を 1 つ足すだけでよい(4.14)。

```text
app ──(proxy設定: CONNECT)──▶ morpheus (127.0.0.1, mode:"connect") ──▶ istio-proxy (mTLS) ──▶ 下流サービス
```

- app は proxy 設定(grpc-go の `GRPC_PROXY_ADDR` 等)で morpheus を指す。下流アドレスは据え置き
- morpheus は CONNECT authority(`ms-b:50052` 等)をその接続の upstream として転送する。
  1 つの listener で複数下流(ms-b / ms-c / ms-d …)を同時に傍受できる
- app → morpheus は pod 内 loopback のため istio に捕捉されず、morpheus → 下流は pod を
  出るため istio-proxy が mTLS 化する
- app への inbound(peer からの request / app が返す response)には触れない

#### 副方式: reverse listener(固定 upstream への転送)

listener に固定 `upstream` を設定する従来型の reverse proxy 構成。CONNECT 方式で足りる
限り不要だが、client に proxy 設定を入れられない場合や、app への inbound を挟みたい場合に使う。

```text
inbound:  peer service → istio-proxy (mTLS 終端) → morpheus-proxy → app
outbound: app → morpheus-proxy → istio-proxy (mTLS) → 下流サービス
```

- inbound: 呼ばれる側の Service `targetPort` を morpheus に向け、morpheus の upstream を
  同一 pod の app(`http://127.0.0.1:<appPort>` / `h2c://127.0.0.1:<appPort>`)にする。
  peer からの request / それに対する app の response を挟む
- outbound(reverse): app が下流サービスを呼ぶ宛先を morpheus(`127.0.0.1:<outPort>`)に
  向け替え、morpheus の upstream を実際の下流サービス(`h2c://<downstream>:<port>` 等)にする。
  下流が複数ある場合は下流ごとに listener を 1 つ立て、app 側の各宛先をそれぞれに向ける
- reverse listener と upstream は 1:1 で対応する。1 つの reverse listener は 1 つの upstream に
  固定で転送し、host / path ベースの複数宛先 routing は行わない

#### 共通の規則

- Core は方向(inbound / outbound)や mode の区別に依存しない。「listener で受けて upstream に
  流す」だけであり、rule 評価・action・logging はどの構成でも同一に働く
- listener は複数構成できる(mode / protocol / 下流ごと)。listener の `name` と `port` は
  一意でなければならない。同じ protocol の listener を別ポートで複数持つのは正当な構成
- CONNECT 方式と reverse 方式は併用できる(例: outbound は connect listener、inbound は
  reverse listener)

注意: ms 自身が mesh を経由せず直接 TLS で外部と通信する traffic(例: 外部 SaaS への HTTPS、Spanner / GCS 等の Google API client)は istio でも morpheus でも復号できないため、inspect 対象外である。`mode: "connect"` で CONNECT トンネルに通せても、トンネル内が client 終端の TLS である限り morpheus は暗号文しか見えず manipulate できない。これらのテストは各サービスの emulator / mock を使う。

### 3.3 Data plane

Data plane は受け取った proxy traffic を処理する。

- HTTP/1.1 request / response
- HTTP/2 (h2c) request / response
- gRPC unary / streaming

Data plane のデフォルト動作は「何もしないで透過転送」である。ルールが一致した場合だけ、mock、fault injection、delay、request / response manipulation などを行う。

### 3.4 Control plane

Control plane は管理 API と Web UI を提供する。管理 API は proxy listener とは独立した専用の admin port でのみ公開する。proxy listener 上では管理 API を公開しない。これにより実サービス traffic と管理 traffic は完全に分離され、実サービスの path と管理 API の path が衝突することはない。

- 管理 base path は設定可能とし、既定は `/_morpheus`
- 管理 API は `<basePath>/api/v1/*`
- Web UI は `<basePath>/`(React SPA を static 配信)
- health endpoint は `<basePath>/healthz/live` と `<basePath>/healthz/ready`

### 3.5 Listener モード

| モード | 用途 | inspect / intercept |
| --- | --- | --- |
| `http` | HTTP/1.1 / HTTP/2 (h2c) reverse proxy | header/path/body/response の inspect と変更が可能 |
| `grpc` | gRPC over HTTP/2 (h2c) | metadata/path/message/trailer/grpc-status の inspect と変更が可能 |

- `http` listener は HTTP/1.1 と HTTP/2 (h2c) を受け付け、可能なら自動判別する
- rule の `protocol: "http"` は HTTP/1.1 / HTTP/2 の両方に適用される
- L7 rule は `http` / `grpc` listener のみに適用される
- 上表の `http` / `grpc` は listener の **protocol** である。これとは別に listener は ingress の **mode**
  を持つ: `reverse`(既定、固定 upstream に転送)と `connect`(HTTP CONNECT を受け、authority を
  upstream にする / 4.14)。どちらの mode でも上記 protocol の inspect / intercept 能力は同じ

## 4. Core Specification

### 4.1 デフォルト転送と proxy 基盤動作

#### 4.1.1 転送の透過性

明示的な rule が一致しない限り、proxy は traffic を一切変更しない。upstream response は status code、header、body を変換せずそのまま client に返す。

- 転送時に header は原則そのまま維持する。`X-Forwarded-For` / `Via` などの proxy header は付与しない
- hop-by-hop header(`Connection`、`Keep-Alive`、`Proxy-Connection`、`TE`、`Trailer`、`Transfer-Encoding`、`Upgrade`)は RFC 9110 に従い、転送する接続に合わせて処理する
- `Host` / `:authority` は書き換えずそのまま upstream に送る
- HTTP/1.1 chunked trailer、HTTP/2 trailer は passthrough する
- WebSocket / `Upgrade` request は rule 適用対象外とし、バイト単位で passthrough する
- 本仕様で挙動が言及されていない traffic / 要素は、原則として何もせず passthrough する
- rule 未設定時は body を buffer せず streaming で転送する
- upstream への接続は keep-alive / connection pool で再利用してよい(実装詳細)

#### 4.1.2 Upstream 障害時の応答

upstream から response が返った場合は、その内容が error であってもそのまま返す(変換しない)。upstream から response 自体を得られなかった場合のみ、proxy が以下の response を生成する。

| 障害 | HTTP | gRPC |
| --- | --- | --- |
| 接続失敗(connection refused / DNS 解決失敗) | `502 Bad Gateway` | `grpc-status: 14 UNAVAILABLE` |
| upstream timeout | `504 Gateway Timeout` | `grpc-status: 4 DEADLINE_EXCEEDED` |
| 転送中の connection reset | `502 Bad Gateway`(response 未送出時) | `grpc-status: 14 UNAVAILABLE`(trailer 未送出時) |

- proxy 生成 response には header `x-morpheus-error: <reason>` を付与する
- response header 送出後に upstream との接続が切れた場合は、client との接続も切断する(途中から proxy が response を捏造しない)
- これらは traffic log に `outcome: "upstream_error"` として記録する

#### 4.1.3 Trace id

- 透過転送時も request ごとに request id を生成または継承し、traffic log と proxy 生成 response の metadata に関連付ける

#### 4.1.4 ログ保存の基本方針

- capture / intercepted traffic の request / response metadata はログ保存対象である
- body payload は capture 用 rule に一致した、または intercept / manipulation された traffic だけ保存する
- unmatched passthrough traffic は traffic log に保存しない
- log 書き込みは非同期に行い、request 処理をブロックしない

### 4.2 管理 API

管理 API は JSON over HTTP とする。base path は `<basePath>/api/v1`(既定 `/_morpheus/api/v1`)とする。以降の例は既定 base path で記載する。

#### 4.2.1 共通仕様

Content-Type:

- request / response とも `application/json`(body を持つ場合)

エラーレスポンス形式(全 endpoint 共通):

```json
{
  "error": {
    "code": "rule_validation_failed",
    "message": "match.pattern is not a valid regular expression",
    "details": [
      {
        "path": "match.pattern",
        "reason": "invalid_regex"
      }
    ]
  }
}
```

HTTP status の使い分け:

| status | 用途 |
| --- | --- |
| `400` | validation error、malformed request |
| `404` | 対象 resource が存在しない |
| `409` | revision conflict |
| `500` | proxy internal error |

Pagination(list 系 endpoint 共通):

- cursor 方式とする: `?limit=50&cursor=<opaque>`
- `limit` の既定は 50、最大は 200
- response は `{ "items": [...], "nextCursor": "<opaque>" | null }`
- log の list は新しい順に返す
- rule の list は件数が少ない前提で pagination を適用せず全件返す

認証:

- 管理 API に認証は設けない(非目標参照)。既定 bind は `127.0.0.1` とし、必要な場合のみ config で変更する

#### 4.2.2 Health

```text
GET /_morpheus/healthz/live
GET /_morpheus/healthz/ready
```

- `live`: プロセスが応答可能なら `200`
- `ready`: 全 listener の bind が完了し、config / rule preset / descriptor の初期 load が完了していれば `200`、そうでなければ `503`

#### 4.2.3 Status

```text
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

#### 4.2.4 Rule CRUD

```text
GET    /_morpheus/api/v1/rules
POST   /_morpheus/api/v1/rules
GET    /_morpheus/api/v1/rules/:id
PUT    /_morpheus/api/v1/rules/:id
DELETE /_morpheus/api/v1/rules/:id
POST   /_morpheus/api/v1/rules:disable-all
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
- `PUT` / `DELETE` / `rules:import` / `rules:disable-all` は `expectedRevision` を受け取り、古い UI からの上書きを防ぐ
- `expectedRevision` が現在の rule revision と一致しない場合は `409 Conflict` を返し、client に rule reload を促す
- `DELETE` は logical delete ではなく即時削除とする
- 一時停止したい場合は `enabled: false` に更新する
- `rules:disable-all` は全 rule を `enabled: false` にする(UI の one-click disable all と対応)
- `rules:validate` は rule 定義(単体または配列)を受け取り、登録せずに validation 結果(error / warning の一覧)だけを返す。UI の保存前チェックに使う

#### 4.2.5 Rule state

```text
GET  /_morpheus/api/v1/rules/:id/state
POST /_morpheus/api/v1/rules/:id/state:reset
```

state は以下を返す。

```json
{
  "ruleId": "rule-503-three-times",
  "hits": 3,
  "consumed": 3,
  "remaining": 0,
  "lastMatchedAt": "2026-06-10T00:00:03.000Z"
}
```

- `state:reset` は hit count と consume counter を初期化する
- rule の update / delete でも counter は初期化される

#### 4.2.6 Simulation

```text
POST /_morpheus/api/v1/rules:simulate
```

- 保存済み traffic log、または request body で与えた sample request に対して、現在の rule set または編集中の rule draft を適用した場合の結果を返す
- request body / response body を使った simulation には、事前に capture 用 rule を設定して対象 traffic を logging しておくか、`sampleRequest` / `sampleResponse` を与える必要がある
- consume counter は消費しない
- upstream には送信しない
- traffic は実際には変更せず、どの rule が一致し、どの action が選択され、どの field が変更されるかを返す
- script matcher / manipulator は sandbox 内で実行し、error / timeout は simulation result と application log に記録する

Simulation request 例:

```json
{
  "logIds": ["2026-06-10T00-00-00.000Z-000001"],
  "ruleDraft": {
    "id": "draft-rule",
    "protocol": "http",
    "match": {
      "type": "regex",
      "field": "path",
      "pattern": "^/users"
    },
    "response": {
      "action": {
        "type": "script_manipulator",
        "language": "javascript",
        "source": "return { body: ctx.response.body.replace('real', 'mock') };"
      }
    }
  },
  "options": {
    "includeBodyDiff": true
  }
}
```

Sample request による simulation 例:

```json
{
  "sampleRequest": {
    "protocol": "http",
    "method": "GET",
    "path": "/users/1",
    "headers": { "x-test": "1" },
    "body": "{}"
  },
  "sampleResponse": {
    "statusCode": 200,
    "headers": { "content-type": "application/json" },
    "body": "{\"name\":\"real-user\"}"
  }
}
```

入力の規則:

- `logIds` と `sampleRequest` はどちらか一方を必須とする(両方指定は `400`)
- `sampleResponse` は `sampleRequest` と併用し、response 段階の simulation に使う。省略時は request 段階のみ simulate する
- `ruleDraft` を省略した場合は現在の rule set を適用する
- log に body が保存されていない場合、body を参照する matcher / action の simulation 結果は `skipped: body_not_logged` とする

#### 4.2.7 Import / Export

```text
POST /_morpheus/api/v1/rules:export
POST /_morpheus/api/v1/rules:import
```

rule は on-memory で永続化されないため、import / export が rule と script を手元に残すための正式な出入り口である。

Export:

- request: `{ "ids": ["rule-a", "rule-b"] }`。`ids` 省略時は全件
- response:

```json
{
  "formatVersion": 1,
  "exportedAt": "2026-06-10T00:00:00.000Z",
  "rules": [
    { "schemaVersion": 1, "id": "rule-a", "...": "..." }
  ]
}
```

- rule 定義(script source を含む)を完全な形で出力する
- 実行時 state(hits / consumed / remaining)は含めない
- gRPC descriptor は含めない(descriptor API で別途管理する)
- script source が export に含まれるため、script に secret を埋め込まないこと

Import:

- request:

```json
{
  "mode": "merge",
  "expectedRevision": 12,
  "rules": [ { "schemaVersion": 1, "id": "rule-a", "...": "..." } ]
}
```

- `mode: "merge"`: `id` が一致する rule は上書き、それ以外は追加する
- `mode: "replace"`: 現在の rule set 全体を import 内容で置き換える
- import 対象の全 rule を validation してから atomic に反映する。1 つでも validation に失敗した場合は `400` を返し、何も反映しない
- import / merge で上書きされた rule の consume counter は初期化される

#### 4.2.8 Log API

```text
GET    /_morpheus/api/v1/logs
GET    /_morpheus/api/v1/logs/:id
GET    /_morpheus/api/v1/logs/:id/request
GET    /_morpheus/api/v1/logs/:id/response
GET    /_morpheus/api/v1/logs/:id/export
GET    /_morpheus/api/v1/logs/events
DELETE /_morpheus/api/v1/logs
```

- `GET /logs` は filter / pagination(4.2.1)をサポートする
- `GET /logs/:id/request` と `GET /logs/:id/response` は body log policy により body が保存されている場合だけ payload を返す。body が保存されていない場合は metadata と `bodyLogged: false` / `bodyLoggingSkippedReason` を返す
- `GET /logs/:id/export` は 1 件の log を自己完結した JSON(metadata + 保存済み body)として出力する(6.2 参照)
- `DELETE /logs` は全 log を削除する
- `/logs/events` は SSE でリアルタイム log event を配信する

Filter 例:

- `protocol=http|grpc`
- `method=GET`
- `path=/api/users`
- `grpcService=demo.TimeService`
- `grpcMethod=Now`
- `ruleId=...`
- `outcome=captured|mock|fault|modified|delayed|upstream_error|rule_error`
- `from` / `to`
- `statusCode`
- `grpcStatus`
- `contains`(保存済み metadata / body preview に対する部分一致)

#### 4.2.9 Masking API

log の redaction(mask)設定を起動後に編集するための API。

```text
GET /_morpheus/api/v1/logging/mask
PUT /_morpheus/api/v1/logging/mask
```

- `GET` は現在有効な mask 設定(headers / jsonPaths)を返す
- `PUT` は mask 設定全体を置き換える。preset entry の削除も追加もこの API で行う
- 起動時の初期値は config の `logging.mask`(4.13)から load する
- 変更は on-memory のみで、プロセス再起動で config の値に戻る

### 4.3 Rule model

Rule は以下の JSON model で表現する。`phase` フィールドは存在しない。request 段階の挙動は `request` フィールド、response 段階の挙動は `response` フィールドにそれぞれ optional に記述する。

```json
{
  "schemaVersion": 1,
  "id": "rule-503-three-times",
  "name": "Return 503 for first three user requests",
  "description": "Fault injection for retry test",
  "enabled": true,
  "priority": 100,
  "protocol": "http",
  "match": {
    "type": "regex",
    "field": "path",
    "pattern": "^/users/.*"
  },
  "request": {
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
    }
  },
  "consume": {
    "times": 3
  },
  "logging": {
    "capture": false
  },
  "createdAt": "2026-06-10T00:00:00.000Z",
  "updatedAt": "2026-06-10T00:00:00.000Z"
}
```

#### 4.3.1 フィールド定義

| field | 必須 | default | 説明 |
| --- | --- | --- | --- |
| `schemaVersion` | no | `1` | rule schema の version。import 互換性判定に使う |
| `id` | no | server 生成 | `^[A-Za-z0-9_-]{1,128}$`。未指定時は server が一意な id を生成する |
| `name` | no | `""` | 表示名 |
| `description` | no | `""` | 説明 |
| `enabled` | no | `true` | `false` の rule は評価しない |
| `priority` | no | `0` | 整数。大きい rule を先に評価する |
| `protocol` | yes | - | `http` / `grpc` |
| `match` | yes | - | request に対する matcher(4.4) |
| `request` | no | - | request 段階の設定。`{ delay?, action? }`(4.5) |
| `response` | no | - | response 段階の設定。`{ match?, delay?, action? }`(4.5) |
| `consume` | no | なし | 消費設定(4.6)。未指定時は一致するたびに適用する |
| `logging` | no | `{ "capture": false }` | `capture: true` で対象 traffic の body を保存する |
| `createdAt` / `updatedAt` | server 管理 | - | server が設定する |

構造の規則:

- `request.action` に指定できる action: `mock_response` / `fault` / `request_rewrite`
- `response.action` に指定できる action: `fault` / `response_replace` / `script_manipulator`
- `request` / `response` の両方を持つ rule は、request 送信前に `request` を適用し、upstream response 受信後に `response` を適用する
- `response` の適用対象は、この rule の `match` に一致した request に対応する response だけである。他の request / response には影響しない
- `response.match` は upstream response に対する追加条件(optional)。一致しない場合、response 段階は何もしない
- `request.action` が `mock_response` または `fault` の場合、upstream に転送しないため upstream response は存在しない。この場合 `response` は適用されない(terminal な `request.action` と `response` を併記した rule は validation warning とする)
- `request` / `response` のどちらも持たない rule は `logging.capture: true` が必須である(capture 専用 rule)。どちらもなく capture もない rule は validation error とする

`logging.capture` は通信を変更せずに対象 traffic の body を保存したい場合に使う。rule 追加前に simulation 用 log を収集する用途を想定する。

#### 4.3.2 Rule evaluation

rule は以下の 2 種類に分類される。

- **observation rule**: `request` / `response` を持たない rule(capture 専用)。何個一致してもよく、評価を停止しない
- **intercept rule**: `request` または `response` を持つ rule。1 つの request / response に対して最初に一致した 1 つだけを適用する(1 request / response につき改変は 1 action)

評価アルゴリズム:

```text
onRequest(req):
  rules = currentRuleSet             # この request の処理中は revision を固定する
            .filter(enabled && protocol == listener.protocol)
            .sortBy(priority desc, createdAt asc)
  interceptRule = null
  for rule in rules:
    if !evalMatch(rule.match, req): continue
    if rule.consume && !tryConsume(rule):   # 消費しきった rule は
      continue                              # 一致しなかったものとして次の rule を評価する
    recordHit(rule)
    if rule is observation:
      markCapture(req, rule)                # 評価は継続する
      continue
    interceptRule = rule                    # 最初に一致した intercept rule で確定
    break

  if interceptRule?.request?.delay: applyDelay()
  if interceptRule?.request?.action:
    result = apply(interceptRule.request.action)
    if result is mock_response or fault:
      return respondToClient(result)        # upstream へ転送しない。response 段階も実行しない
    # request_rewrite の場合は書き換えた request を転送する

  resp = forwardToUpstream(req)

onResponse(resp):
  if interceptRule?.response:
    if interceptRule.response.match && !evalMatch(interceptRule.response.match, resp):
      return respondToClient(resp)          # 追加条件に不一致なら何もしない
    if interceptRule.response.delay: applyDelay()
    if interceptRule.response.action: resp = apply(interceptRule.response.action)
  return respondToClient(resp)
```

規則のまとめ:

- `priority` が大きい rule を先に評価する
- `priority` が同じ場合は `createdAt` が早い rule を先に評価する(`updatedAt` は評価順に影響しない)
- 消費型 rule が消費しきっている場合、その rule はスキップされ、次に一致する rule(より低い priority の rule を含む)が適用される。どの rule にも一致しなければ passthrough する
- observation rule は non-terminal であり、後続 rule の評価を止めない
- intercept rule は最初に一致した 1 つだけが適用される。intercept rule に一致した traffic は traffic log に記録されるため、より低い priority の capture rule に到達しなくても traffic の検証は可能である
- proxy が生成した response(mock / fault / upstream error)には response 段階の rule を適用しない
- 複数の改変を 1 つの request / response に適用したい場合は、1 つの rule の中で `request` と `response` を併用するか、script manipulator で複数の変更をまとめて行う

### 4.4 Matcher

Matcher は簡易 matcher と script matcher の 2 種類をサポートする。`match`(request 対象)と `response.match`(response 対象)の両方で同じ matcher 構造を使うが、参照できる field が異なる。

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

Request matcher(`match`)で使える field:

| field | HTTP | gRPC | 備考 |
| --- | --- | --- | --- |
| `method` | yes | no | HTTP method |
| `host` | yes | yes | Host または `:authority` |
| `path` | yes | yes | HTTP path または gRPC `:path` |
| `query` | yes | no | query string |
| `header.<name>` | yes | yes | HTTP header / gRPC metadata |
| `body` | yes | limited | text / json / decoded gRPC message |
| `rawBodyBase64` | yes | yes | binary payload |
| `grpc.service` | no | yes | `/package.Service/Method` から抽出 |
| `grpc.method` | no | yes | `/package.Service/Method` から抽出 |

Response matcher(`response.match`)で使える field:

| field | HTTP | gRPC | 備考 |
| --- | --- | --- | --- |
| `status` | yes | no | HTTP status code(文字列化して regex match、例 `^5\\d\\d$`) |
| `header.<name>` | yes | yes | response header / gRPC initial metadata |
| `body` | yes | limited | text / json / decoded gRPC message |
| `rawBodyBase64` | yes | yes | binary payload |
| `grpc.status` | no | yes | trailer の grpc-status |
| `grpc.trailer.<name>` | no | yes | gRPC trailer |

制約:

- request matcher に response 系 field(またはその逆)を指定した rule は validation error とする
- body matching は body buffering limit(4.8.3)内の payload のみ対象とする
- HTTP binary body は既定では base64 文字列に対して match する
- gzip など圧縮 body は `decodeBody: true` の listener でのみ展開して match する
- gRPC message body は descriptor が登録されていれば JSON 化した message に match できる
- gRPC message body は descriptor がない場合、matcher / manipulator / UI preview の対象にしない
- streaming と判定された gRPC method では body 系 field(`body` / `rawBodyBase64`)を含む matcher は評価せず不一致として扱う(4.7.5)

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
  "timeoutMs": 3000,
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
  protocol: 'http' | 'grpc';
  stage: 'request' | 'response';
  request: {
    id: string;
    method?: string;
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

- `ctx.response` は `response.match` として実行される場合(`stage: 'response'`)のみ存在する

Security / 実行制御:

- script matcher / manipulator は初期仕様からサポートする
- script は proxy 本体とは別の sandbox subprocess(Node.js)で実行する
- sandbox では `fs` / `net` / `process` / filesystem access / dynamic import を禁止する
- 1 回の実行 timeout は rule ごとに `timeoutMs` で設定できる。既定は 3 秒(config `script.defaultTimeoutMs`)。ユーザーが明示的に設定した場合はその値に従う(上限は config `script.maxTimeoutMs`、既定 60 秒)
- script の compile error / runtime error / timeout は rule execution failure として traffic log と application log の両方に残す
- script error / timeout が発生した場合、その rule は request / response を編集せず passthrough する
- script timeout または freeze を検知した場合、該当 sandbox subprocess を停止し、新しい sandbox subprocess を起動する
- app 側では script の CPU / memory 上限は設けず、必要に応じて実行環境側で制御する
- script source は log と export に含まれるため、secret を埋め込まない

### 4.5 段階設定と Action

`request` / `response` の各段階は以下の構造を持つ。

```ts
type RequestStage = {
  delay?: Delay;
  action?: RequestAction;   // mock_response | fault | request_rewrite
};

type ResponseStage = {
  match?: Matcher;          // upstream response への追加条件
  delay?: Delay;
  action?: ResponseAction;  // fault | response_replace | script_manipulator
};
```

- `delay` と `action` はそれぞれ optional である。`delay` だけの段階(遅延のみ)も、`action` だけの段階も有効である
- ただし `request` / `response` を指定する場合は `delay` か `action` の少なくとも一方を含めること。空 object(`"request": {}` など)は validation error とする
- 「delay + 改変」のような複合挙動は、同じ段階に `delay` と `action` を並べて表現する。action を多段に連鎖させる pipeline 機構は設けない(1 request / response につき改変は 1 action)

#### 4.5.1 Delay

```json
{
  "durationMs": 500
}
```

```json
{
  "durationMs": 3000,
  "mode": "total"
}
```

| mode | 適用可能な段階 | 意味 |
| --- | --- | --- |
| `fixed`(既定) | request / response | 指定時間だけ追加で遅延する |
| `total` | response のみ | proxy が request を受理してから client へ response を返し始めるまでの合計時間が `durationMs` になるように遅延を調整する |

`total` mode の詳細:

- 合計時間には「proxy → upstream の転送時間 + upstream の処理時間 + upstream → proxy の応答到達時間」が含まれる。proxy はそれらの実測経過時間を `durationMs` から差し引いた残り時間だけ遅延する
- 実測経過時間がすでに `durationMs` 以上の場合、追加の遅延は行わず即座に返す。このとき log に `delaySkipped: true` を記録する
- client timeout の精密なテストを想定した mode である
- `total` を request 段階に指定した rule は validation error とする
- streaming response では response header を client へ返す前に遅延を適用する(`total` の終点は response header 送出開始とする)

適用位置:

- request 段階: upstream への転送前に遅延する
- response 段階: client への返却前に遅延する

#### 4.5.2 Fault

request 段階に指定した場合は upstream へ転送せず即座に応答を生成する。response 段階に指定した場合は upstream response を破棄して応答を差し替える。

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

Timeout fault:

```json
{
  "type": "fault",
  "fault": {
    "kind": "timeout",
    "durationMs": 30000
  }
}
```

Fault kind:

| kind | HTTP | gRPC | 説明 |
| --- | --- | --- | --- |
| `http_response` | yes | no | 指定した HTTP response を返す |
| `grpc_status` | no | yes | 指定した gRPC status を返す(HTTP status は `200`、trailer で `grpc-status` を返す) |
| `connection` | yes | yes | `mode: "close"` は正常 close、`mode: "reset"` は TCP RST |
| `timeout` | yes | yes | 応答を返さず接続を保留し、`durationMs` 経過後に connection close する。`durationMs` 省略時は client が切断するまで無応答を維持する |

- `timeout` fault で保留中の接続は idle timeout(4.11)の対象外とするが、max concurrent connections にはカウントする
- `grpc_status` fault の `status` は 0-16 の整数。message body を伴わない fault は descriptor なしでも登録できる(4.7.3)

#### 4.5.3 Mock response

request 段階専用。upstream へ転送せず指定した response を返す。

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

- gRPC mock response は descriptor がある場合のみ JSON mapping または textproto を protobuf binary に encode する。descriptor がない場合、body を伴う mock response は登録不可とし、`grpc-status` / `grpc-message` のみを返す fault injection に限定する
- gRPC mock は unary method のみ対象とする(streaming method への mock 登録は validation error)

#### 4.5.4 Request rewrite

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
      "op": "remove_header",
      "name": "x-remove-me"
    },
    {
      "op": "set_path",
      "value": "/v2/users"
    },
    {
      "op": "set_query",
      "value": "debug=true"
    },
    {
      "op": "replace_body",
      "from": "\"env\":\"prod\"",
      "to": "\"env\":\"test\""
    }
  ]
}
```

- `set_header` / `remove_header` / `set_path` / `set_query` / `replace_body` をサポートする
- `replace_body` の `from` は正規表現、`to` は置換文字列(capture group 参照 `$1` 可)。text body のみ対象とする
- Request rewrite は upstream に送る前に適用する。ログには original request と forwarded request の両方を保存する
- 書き換え後の request に対して他の rule を再評価することはない

#### 4.5.5 Response replace

response 段階専用の簡易置換。対象は response header(gRPC では initial metadata)のみとする。

```json
{
  "type": "response_replace",
  "target": "header.x-data-source",
  "from": "^real-(.*)$",
  "to": "mock-$1"
}
```

- `target` は `header.<name>` 形式のみサポートする
- `from` は正規表現、`to` は置換文字列(capture group 参照 `$1` 可)
- 対象 header が複数値を持つ場合は各値に適用する
- 対象 header が存在しない場合は何もしない
- body / gRPC trailer / gRPC message の変更は script manipulator(4.5.6)で行う

#### 4.5.6 Script manipulator

response 段階専用。元 request と upstream response を受け取り、response への patch を返す manipulator 関数を登録できる。

```json
{
  "type": "script_manipulator",
  "language": "javascript",
  "timeoutMs": 3000,
  "source": "return { body: ctx.response.body.replace('real', 'mock') };"
}
```

関数 signature:

```ts
type ResponseManipulator = (
  ctx: ManipulatorContext
) => ResponsePatch | Promise<ResponsePatch>;
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

戻り値は protocol ごとの union type とする。

```ts
type HttpResponsePatch = {
  statusCode?: number;
  headers?: Record<string, string | string[] | null>;
  body?: string;
  rawBodyBase64?: string;
};

type GrpcResponsePatch = {
  metadata?: Record<string, string | string[] | null>;
  messages?: unknown[];
  grpcStatus?: number;
  grpcMessage?: string;
  trailers?: Record<string, string | string[] | null>;
};

type ResponsePatch = HttpResponsePatch | GrpcResponsePatch;
```

Patch のセマンティクス:

- すべての field は optional である
- 明示的に指定しなかった field は、upstream response の値を可能な限りそのまま維持する(部分 patch)
- `headers` / `metadata` / `trailers` の value に `null` を指定した場合、その header を削除する。指定しなかった header は upstream のまま維持する
- `body` と `rawBodyBase64` を同時に返した場合は runtime error として扱い、rule execution failure(passthrough)とする
- protocol と patch の内容が一致しない field(HTTP response への `grpcStatus` など)は無視し、warning を log に記録する

制約:

- Security / timeout は script matcher(4.4.3)と同じである
- body size limit を超えた response には既定では適用しない(4.8.3)
- gRPC streaming では `messages` を含む patch は適用せず warning を記録する。`metadata` / `trailers` / `grpcStatus` / `grpcMessage` のみ適用できる(4.7.5)

### 4.6 消費型 rule

消費型設定は fault injection に限らず、mock、request / response 改変を含むすべての rule に付けられる。「最初の N 回だけ適用し、その後は次の rule 評価または正常系へ戻る」テストに使う。

```json
{
  "consume": {
    "times": 3
  }
}
```

| field | 必須 | 説明 |
| --- | --- | --- |
| `times` | yes | 適用回数の上限。1 以上の整数 |
| `resetAfterMs` | no | 最後に消費されてから指定時間が経過すると counter を初期状態に戻す |

Consume state:

- 消費 counter は `rule.id` ごとに同一 process 内で管理する
- 同じ rule を並列テストで分離したい場合、ユーザは matcher 側で test id や header value を条件に含め、別 rule として定義する
- proxy は `rule.id` 以外の per-user / per-header counter key は初期仕様では提供しない
- `consume` が未指定の場合は消費せず、matcher に一致するたびに適用する
- counter は rule update / delete / state reset で初期化できる
- counter の check / decrement は `rule.id` ごとの短い critical section で行う
- upstream 転送、response 待ち、script 実行中は consume lock を保持しない
- 初期仕様は single process 前提とし、multi-process / multi-instance 間の counter 同期は行わない
- 消費は rule が request 段階で一致・選択された時点で 1 回行う。`request` と `response` の両方を持つ rule でも消費は 1 request につき 1 回である

消費しきった後の動作(exhausted):

- 消費しきった rule は matcher に一致しても適用されず、rule evaluation(4.3.2)では「一致しなかった」ものとしてスキップされる
- その結果、次に一致する rule(より低い priority の rule を含む)が適用され、どの rule にも一致しなければ upstream へ透過転送される
- この動作は固定であり、設定項目(`afterExhausted` のようなもの)は設けない

### 4.7 gRPC handling

#### 4.7.1 対応範囲

| 項目 | unary | streaming(server / client / bidi) |
| --- | --- | --- |
| metadata / path の matcher | yes | yes |
| message body の matcher | yes(descriptor 必須) | no |
| grpc-status / trailer の matcher(`response.match`) | yes | yes |
| metadata の edit | yes | yes |
| trailer / grpc-status の edit | yes | yes |
| message body の mock / manipulation | yes(descriptor 必須) | no(passthrough 固定) |
| delay | yes | yes |
| `grpc_status` fault | yes | yes |
| body logging | yes(descriptor 必須) | no |

初期実装では unary を優先する。streaming は message body の buffering / rewrite を行わず passthrough するが、HTTP/2 header / gRPC metadata / trailer / grpc-status の inspect と edit はサポートする(4.7.5)。

gRPC body の表示、matcher、mock body 生成、manipulation は descriptor または `.proto` が提供されている場合のみ許可する。descriptor がない場合、proxy は protobuf binary を decode / encode できないため、body を UI に表示せず、body matcher / body manipulator / JSON mock response を許可しない。

gRPC method が unary か streaming かの正確な判定は descriptor に依存する。descriptor がない場合は streaming 判定ができないため、body を変更せず passthrough し、metadata / trailer / status に対する操作のみ許可する。

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
- delay の適用位置は段階で決まる: request 段階の delay は upstream への転送前、response 段階の delay は client への response 返却前(response header 送出前)に適用する

#### 4.7.5 Streaming の扱い

descriptor によって streaming method と判定された RPC、または descriptor がなく判定不能な RPC は以下のように扱う。

- message body は buffer せず passthrough する
- request 段階: metadata / path matcher の評価、`request_rewrite`(header 操作のみ、`replace_body` は不可)、delay、`grpc_status` / `connection` / `timeout` fault(upstream へ転送せず即時に応答)を適用できる
- response 段階: `response.match`(`header.<name>` / `grpc.status` / `grpc.trailer.<name>`)の評価、`response_replace`(initial metadata)、script manipulator による `metadata` / `trailers` / `grpcStatus` / `grpcMessage` の patch、delay を適用できる
- body 系 field(`body` / `rawBodyBase64`)を含む matcher は評価せず不一致として扱う
- `messages` を含む mock / patch、`replace_body` は適用せず、rule validation 時に warning、実行時には skip として log に記録する
- streaming の body logging は行わない(metadata / trailer / status のみ記録する)
- response 段階の `grpc.status` / `grpc.trailer.<name>` は trailer 到達時に評価できる。trailer の書き換え(script manipulator の `trailers` / `grpcStatus` / `grpcMessage` patch)は upstream trailer を受信してから client へ返す trailer に適用する

### 4.8 HTTP handling

#### 4.8.1 対応範囲

- HTTP/1.1
- HTTP/2 (h2c)
- request / response header
- query string
- text body
- JSON body
- binary body capture
- compressed body capture
- WebSocket / Upgrade は rule 適用外の byte passthrough(4.1.1)

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
- 設定は listener ごとの `maxRequestBodyBufferBytes` / `maxResponseBodyBufferBytes`(4.13)

Size 判定:

- HTTP/1.1 / HTTP/2 の `content-length` が存在し、limit を超える場合は body を読み込まず拒否する
- `content-length` が存在しない場合、読み込みながら byte 数を加算し、limit 超過時点で拒否する
- HTTP request body limit 超過時は `413 Payload Too Large` を返す
- gRPC message / body limit 超過時は `grpc-status: 8 RESOURCE_EXHAUSTED` を返す
- response 段階の manipulation で upstream response が limit を超えた場合、その response は改変せず passthrough し、limit exceeded event を log に残す

Streaming:

- HTTP streaming と判定できる request / response は body を buffer せず passthrough する
- streaming traffic でも header の inspect / edit は許可する
- streaming traffic に body matcher / body manipulator rule が設定された場合、その rule は validation warning または execution skip として扱い、body は変更しない

### 4.9 Logging

Logging は traffic log と application log を分ける。

Traffic log:

- proxy を通過した capture / intercepted traffic の request / response metadata を記録する
- capture 用 rule に一致した、または intercept / manipulation された request / response の body を記録する
- fault injection / mock で生成した response を記録する
- passthrough だけの unmatched traffic は traffic log に保存しない

Traffic capture workflow:

1. まず capture 用 rule(observation rule)を登録する
2. capture rule に match した request / response は通信を変更せず passthrough し、body log policy に従って body を保存する
3. 保存された traffic log に対して `rules:simulate` を実行し、追加予定の rule がどう match / manipulate するか確認する
4. simulation 結果を確認してから、本番の fault / mock / manipulation rule を登録する

Capture rule は `request` / `response` を持たず `logging.capture: true` を持つ observation rule として表現する。observation rule は non-terminal として扱われ、後続 rule の評価を止めない(4.3.2)。

```json
{
  "id": "capture-users",
  "enabled": true,
  "priority": 10,
  "protocol": "http",
  "match": {
    "type": "regex",
    "field": "path",
    "pattern": "^/users"
  },
  "logging": {
    "capture": true
  }
}
```

Application log:

- proxy process の起動・停止
- config 読み込みの warning(default fallback の発生を含む)
- listener lifecycle
- admin API error
- rule validation error
- script compile / runtime / timeout error
- gRPC descriptor validation error
- protobuf decode / encode error
- log retention error

Traffic log と application log は別々の sink / file / directory に保存する。片方の retention や redaction 設定がもう片方に影響しないようにする。log 書き込みは非同期に行い、request 処理をブロックしない。

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

`outcome` の値:

| outcome | 意味 |
| --- | --- |
| `captured` | observation rule による capture のみ(通信は無変更) |
| `mock` | mock response を返した |
| `fault` | fault injection を実行した |
| `modified` | request / response のいずれかを改変した |
| `delayed` | delay のみ適用した |
| `upstream_error` | upstream 障害により proxy が response を生成した |
| `rule_error` | script error などにより rule 適用に失敗し passthrough した |

- 複数が該当する場合の優先順位は `mock` / `fault` > `modified` > `delayed` > `captured` とする(例: fault + delay は `fault`、改変 + delay は `modified`)
- intercept rule に一致したが `response.match` が不一致で改変が行われなかった場合、outcome は `captured` とし、`matchedRules` に response 条件が不一致だった旨を記録する

`loggingReason` の値: `capture_rule` / `matched_rule` / `upstream_error` / `rule_error`

#### 4.9.2 保存対象

- traffic metadata for capture / intercepted / fault / mock / manipulated traffic
- matched rule 一覧
- applied action 一覧
- `logging.capture: true` の rule に一致した original request / returned response
- intercept / manipulation された original request
- request rewrite 後の forwarded request
- response 段階の rule に一致した upstream response
- client に返した returned response
- fault injection / mock で生成した response
- request / response manipulation 前後の差分
- proxy internal error
- upstream error
- script error / timeout
- gRPC decode / encode error
- timing breakdown(delay `total` mode の実測値・`delaySkipped` を含む)

#### 4.9.3 Body log policy

- unmatched passthrough traffic は traffic log に保存しない
- `logging.capture: true` の rule に一致した HTTP request / response は raw body を file に保存する
- intercept / manipulation された HTTP request / response は raw body を file に保存する
- matcher に一致しても `logging.capture: true` がなく、改変も行われなかった場合、body は保存しない
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

Retention は config(4.13)の `logging` セクションで設定する。

- `trafficLogDir` / `appLogDir`
- `trafficMaxEntries`
- `trafficMaxBytes`
- `trafficRetentionMs`
- `appRetentionMs`

Retention 超過時は古い log から削除する。削除は metadata、request body、response body を一貫して扱う。

#### 4.9.5 Redaction

テスト用途でも credential が流れる可能性があるため、redaction をサポートする。

- 既定 preset を用意し、起動時に config の `logging.mask`(4.13)から load する
- 起動後は Masking API(4.2.9)で preset entry の削除・変更・追加ができる
- Mask は traffic log の metadata、header、HTTP JSON body preview、gRPC decoded body に適用する
- HTTP raw body file は完全な redaction が難しいため、保存対象を capture / intercepted traffic に限定して leak surface を小さくする

既定 preset:

- headers: `authorization`、`cookie`、`set-cookie`、`x-api-key`
- jsonPaths: `$.password`、`$.token`、`$.credentials.*`

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

### 4.10 Hot load と rule store

#### 4.10.1 Hot load

- 管理 API で rule が更新されると、次の request から新 rule set を使う
- 処理中の request は開始時点の rule revision を使い続ける
- rule compilation(regex compile、script compile、schema validation)は反映前に行う
- validation / compile に失敗した場合は何も反映しない

#### 4.10.2 Rule store

- rule(script rule を含む)は memory store のみとする。process restart で rule は消える
- rule と script を手元に残す手段として import / export API(4.2.7)を提供する。export した JSON は test fixture として再利用できる
- 起動時の初期 rule は config の `rules.presets`(4.13)から load できる(既定は空)

### 4.11 Safety and limits

以下は設定可能にする。

- max request body buffer bytes
- max response body buffer bytes
- max concurrent connections
- max active streams
- upstream timeout
- idle timeout
- script default / max timeout
- log retention

セキュリティ方針:

- dev 環境での利用を前提とし、管理 API / UI の認証は設けない(非目標参照)
- 管理 API は既定で `127.0.0.1` に bind する。remote からのアクセスが必要な場合のみ config で bind host を変更する
- UI から script rule を登録する場合は明示的な confirmation を要求する
- CORS、security headers などは一般的な best practice に従う。UI と管理 API は同一 origin(admin port)で提供されるため CORS は既定 disabled とする

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

- config file path は CLI option(`--config`)または env var `MORPHEUS_CONFIG` で指定する。未指定時は working directory の `morpheus.jsonc` を探す
- **config がなくても app は起動できる。** すべての設定値はアプリ内に hard coded default を持つ
- リポジトリにデフォルト config ファイル(`config/default.jsonc`)を同梱する。その内容はアプリ内の hard coded default と完全に一致させる(一致することをテストで検証する)
- config file が存在しない、読めない、JSONC parse に失敗した場合は、hard coded default 全体で起動し、warning を application log と stderr に出す
- config の一部の key が schema validation に失敗した場合は、その key だけ hard coded default に fallback し、warning を出す。validation に成功した key はその値を使用する
- 参照 descriptor file が読めない場合は、その descriptor だけ skip して warning を出し、起動は継続する
- env var による override は config path などの deployment-specific な項目に限定する

```jsonc
{
  "admin": {
    "host": "127.0.0.1",
    "port": 18081,
    // 実サービスの path と管理 path を混同しないよう、prefix はここで変更できる
    "basePath": "/_morpheus"
  },
  "listeners": [
    {
      "name": "http",
      "protocol": "http",
      "host": "0.0.0.0",
      "port": 18080,
      "upstream": "http://127.0.0.1:8080",
      "decodeBody": false,
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
    // 起動時に load する rule 定義の配列。既定は空
    "presets": []
  },
  "script": {
    "sandbox": "subprocess",
    "defaultTimeoutMs": 3000,
    "maxTimeoutMs": 60000
  },
  "limits": {
    "maxConcurrentConnections": 1024,
    "maxActiveStreams": 1024,
    "upstreamTimeoutMs": 30000,
    "idleTimeoutMs": 60000
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

- `rules.presets` の各 entry は rule model(4.3)と同じ形式とする。validation に失敗した preset rule はその rule だけ skip して warning を出す
- `logging.mask` は起動時の初期値であり、起動後は Masking API(4.2.9)で編集できる(on-memory)
- listener の `mode`(optional、既定 `reverse`)で ingress 方式を選ぶ。`mode: "connect"` の listener は `upstream` を取らない(CONNECT authority が upstream になる / 4.14)

### 4.14 CONNECT egress listener(client proxy 経由の傍受)

本節はデプロイモデルの主方式(3.2)である CONNECT egress listener を定義する。reverse listener(`mode` の config 既定値)は固定 upstream に転送するため、1 つの app が複数下流を呼ぶ場合は下流ごとに listener を立て、app 側の各宛先を書き換える必要がある。`mode: "connect"` は **app の宛先設定を一切変えず、outbound をまとめて 1 つの listener で傍受する**ための mode である。

動作:

- listener は HTTP CONNECT を受ける。app(client)は proxy 設定(grpc-go `GRPC_PROXY_ADDR`、Go `net/http` / 多くの言語の `HTTPS_PROXY`)で morpheus を指すだけでよい。下流アドレス(`ms-b:50052` 等)は据え置き
- morpheus は `CONNECT <host:port> HTTP/1.1` を受理して `200 Connection Established` を返し、その **authority(`<host:port>`)をこの接続の upstream** とする
- トンネル内の平文を通常の pipeline で処理する。listener の `protocol` が `grpc` なら h2c を gRPC として、`http` なら h1/h2 を自動判別して扱う。rule 評価・fault・mock・manipulation・logging・consume はすべて reverse listener と同一
- 処理後、CONNECT authority へ転送する。morpheus → 下流は pod を出るため istio-proxy が mTLS 化する(3.2 と同じ)。traffic log の `target` にはその接続の upstream(CONNECT authority)を記録する
- 1 つの connect listener で複数の下流(ms-b / ms-c / ms-d …)を同時に傍受できる。宛先の判別は CONNECT authority で行い、host/path ベースの routing 設定は不要

制約:

- **opt-in**: proxy 設定をした client の通信だけが morpheus を通る。設定しない client は素通りし傍受されない。全 outbound を漏れなく捕捉したい要件には透過捕捉(Istio `EnvoyFilter` / iptables)が必要で、それは本 proxy の対象外(2.3)
- **平文のみ**: トンネル内が client 終端の TLS(外部 SaaS への HTTPS、Spanner / GCS 等)の場合、morpheus は暗号文を inspect / manipulate できない(3.2 注記)。このような接続は blind 中継せず、平文として解釈できない時点で fail fast する(接続確立が失敗する)。これらのサービスのテストは emulator / mock で行う
- 上記のため、proxy 設定は process 全体の `HTTPS_PROXY` ではなく、mesh 内下流の client だけに効く専用設定(grpc-go の `GRPC_PROXY_ADDR` のような per-client 設定)を推奨する。`HTTPS_PROXY` を使う場合は外部 TLS 宛先を `NO_PROXY` で除外すること
- CONNECT tunnel は inspect が目的であり、中身を見ない opaque な passthrough は行わない(2.3)
- `mode: "connect"` の listener では config の `upstream` は無視する

config 例:

```jsonc
{
  "name": "grpc-egress",
  "protocol": "grpc",
  "host": "127.0.0.1",  // app からのみ使うため loopback
  "port": 15052,
  "mode": "connect"
  // upstream は不要(CONNECT authority が upstream になる)
}
```

app 側は下流アドレスを据え置き、proxy 設定だけ足す:

```text
GRPC_PROXY_ADDR = 127.0.0.1:15052   # grpc-go の CONNECT proxy 先 = morpheus
MS_B_ADDR       = ms-b:50052        # 変更なし(CONNECT の宛先 = upstream になる)
MS_C_ADDR       = ms-c:50053        # 変更なし。同じ morpheus が両方を傍受する
```

## 5. UI Specification

### 5.1 目的

UI は proxy の現在状態を可視化し、テスト中に素早く rule を作成・変更し、実 traffic と fault injection の結果を確認できる管理画面である。

- React で実装し、build した静的 assets を admin server から SPA として配信する
- UI のすべての操作は管理 API(4.2)を呼び出して行う。UI にしかできない操作を作らない

### 5.2 画面構成

| 画面 | 機能 |
| --- | --- |
| Dashboard | listener 状態、request 数、fault 数、rule hit 数、最新 log |
| Rules | rule 一覧、検索、enable / disable、priority 変更、状態 reset、import / export |
| Rule Editor | matcher / request / response / consume 設定、script 編集、validation、simulation |
| Logs | request / response log 一覧、filter、詳細、diff、raw download |
| gRPC Descriptors | descriptor 登録、service / method 確認 |
| Settings | log retention 表示、mask 設定編集、script sandbox 状態、log 表示 timezone 設定 |

### 5.3 Rules 画面

表示項目:

- enabled toggle
- priority
- name
- protocol
- matcher summary
- request / response action summary
- hit count
- remaining count(消費型の場合)
- last matched
- validation status
- rule revision

操作:

- create
- duplicate
- edit
- delete
- enable / disable
- disable all(`rules:disable-all`)
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
- match field / regex pattern / regex flags
- request 段階: delay / action type / action arguments
- response 段階: response match / delay / action type / action arguments
- consume setting(times / resetAfterMs)
- logging.capture

#### 5.4.2 Advanced mode

複合 matcher、request / response 両段階の組み合わせを JSON editor で編集する。

機能:

- JSON schema validation
- format
- validation API 実行
- sample request に対する test match(`rules:simulate` の `sampleRequest` を利用)
- 既存 log に対する `rules:simulate` 実行

#### 5.4.3 Script mode

Script matcher / manipulator を code editor で編集する。

機能:

- syntax highlight
- timeout 設定(既定 3 秒)と timeout warning
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

- timestamp(`YYYY/MM/DD-HH:MM:SS.sss-nnnnn` 形式。`nnnnn` はその log の連番(id 末尾の数字を5桁 0 埋め)で、同一ミリ秒内の複数 log を一意に区別する。サーバーが送る `startedAt` は常に UTC で、表示 timezone への変換は client 側で行う。表示 timezone は Settings(5.2)で選択でき、未指定時は browser 検出、検出不能時は UTC を使う)
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
- この log から matcher / rule を生成(5.7.4)
- 現在の rule set または編集中 rule draft をこの log に適用した場合の simulation 結果

#### 5.5.3 Realtime

SSE で新規 log を streaming 表示する。UI は pause/resume を持ち、pause 中も server side の log は保持される。

### 5.6 Manual matcher / manipulator 登録

UI は script matcher / manipulator を登録できる。ただし以下を必須とする。

- 保存前に validation API を実行
- sample context で simulation 可能
- 既存 log に対する simulation が可能
- script sandbox の状態、実行 timeout、body size limit を表示
- script source が export / log に残ることを明示する

### 5.7 UI 補助機能

以下は UI の正式機能とする。いずれも管理 API の既存機能の組み合わせで実現でき、UI 専用の server 機能を必要としない。

#### 5.7.1 Rule template

パラメータ入力付きの rule 雛形。テンプレートを選ぶと Rule Editor に展開され、保存前に編集・validation できる。

| template | パラメータ | 生成される rule |
| --- | --- | --- |
| HTTP 5xx for first N requests | path pattern、status code、N | request 段階 `fault(http_response)` + `consume.times: N` |
| gRPC UNAVAILABLE for first N requests | service / method、N | request 段階 `fault(grpc_status: 14)` + `consume.times: N` |
| Delay response (fixed) | path pattern、durationMs | response 段階 `delay(fixed)` |
| Delay response (total) | path pattern、durationMs | response 段階 `delay(total)`(client timeout テスト用) |
| Replace response header | path pattern、header name、from regex、to | response 段階 `response_replace` |
| Mock JSON response | path pattern、status code、JSON body | request 段階 `mock_response` |
| Mock gRPC unary response | service / method、JSON message | request 段階 `mock_response`(descriptor 登録済みの場合のみ選択可) |
| Capture traffic | path pattern | observation rule(`logging.capture: true`) |

#### 5.7.2 One-click disable all

- 全 rule を一括で `enabled: false` にする。`POST /rules:disable-all` を呼び出す
- 実行前に confirmation を表示する

#### 5.7.3 Rule hit timeline

- log API の filter(`ruleId`)を使い、rule ごとの hit を時系列チャートで表示する
- consume 残数の推移(log entry の `matchedRules[].remaining`)も表示する

#### 5.7.4 Log から rule / matcher を生成

- log detail から、その request の method / path / header を元にした regex matcher の draft を生成する(path は literal escape した regex とする)
- 「この response を mock 化」: 保存済み response body がある log から `mock_response` rule の draft を生成する
- 生成結果は Rule Editor に draft として展開され、ユーザが編集してから保存する

#### 5.7.5 curl / grpcurl command 生成

- log detail から、その request を再現する `curl`(HTTP)/ `grpcurl`(gRPC)コマンド文字列を生成して clipboard にコピーできる
- body が保存されている場合のみ body 込みのコマンドを生成する。保存されていない場合は metadata のみのコマンドを生成し、その旨を表示する
- gRPC は descriptor が登録されている場合のみ decoded body 込みで生成できる

#### 5.7.6 Import / Export

- Rules 画面から export(全件 / 選択分)をファイル download、import をファイル upload で行う。API は 4.2.7 を使う

#### 5.7.7 その他

- dark / light theme は任意。初期は機能優先でよい

## 6. 将来の機能提案

以下は初期実装には含めないが、現行設計と互換性のある形で方向性を定義しておく。

### 6.1 Test isolation

並列テストで rule と log が衝突しないよう、test run id による namespace を導入する。

- rule に optional field `testId` を追加する。`testId` を持つ rule は、request header `x-morpheus-test-id` の値が一致する場合のみ評価対象とする
- `testId` を持たない rule は従来通りすべての traffic に適用される(global rule)
- traffic log entry に `testId` を記録し、log API の filter に `testId=` を追加する
- `DELETE /rules?testId=...` / `DELETE /logs?testId=...` で test run 単位の一括 cleanup を可能にする
- consume counter は rule 単位のままとする。テストごとの分離は「test run ごとに `testId` 付き rule を登録する」運用で実現する
- UI の Rules / Logs 画面に `testId` filter を追加する

### 6.2 Recording と fixture 化

実 traffic を record し、後続テストの mock rule として再利用する。record した request の再送(replay)は行わない(非目標)。

- capture した log 1 件を自己完結 JSON として出力する `GET /logs/:id/export`(4.2.8)を基盤とする
- export 形式は request / response の metadata と保存済み body を含む。HAR 互換は目指さず、morpheus 独自の flat な JSON とする
- gRPC は descriptor が登録されている場合は decoded JSON body を含め、ない場合は metadata のみとする
- 「log から mock rule を生成」(5.7.4)により、record した response をそのまま fixture 化できる
- 将来的には複数 log をまとめて「path → mock response」の rule set として一括生成する bulk 変換 API(`POST /logs:generate-rules`)を検討する

### 6.3 Contract-aware validation

descriptor / schema を登録できると、UI の body editor と validation が改善する。

- protobuf descriptor set は初期実装に含まれる(4.7.3)
- 将来、HTTP JSON body 向けに JSON Schema / OpenAPI schema を登録できる registry(`POST /_morpheus/api/v1/schemas`)を追加する
- 登録された schema は以下に使う: mock response body の validation、Rule Editor の body 補完・エラー表示、log detail での body の構造表示
- schema がない場合の挙動は現行どおり(text / JSON として扱う)であり、schema 登録は任意とする

### 6.4 Failure distribution

固定回数(consume)に加えて、確率的 fault injection を導入する。

- rule に optional field `trigger` を追加する

```json
{
  "trigger": {
    "type": "probability",
    "rate": 0.1,
    "seed": "test-run-001"
  }
}
```

- `rate` は 0.0-1.0。`seed` は必須とし、deterministic な PRNG(seed + rule ごとの試行連番)で再現性を確保する
- 評価順序: matcher 一致 → trigger 判定 → (当選時のみ)consume 消費 → 適用。trigger に外れた場合は「一致しなかった」ものとして次の rule を評価する
- rule state API に試行数と発火数を追加する
- seed を必須にする理由: deterministic なテストで再現性を維持するため

## 7. 実装優先度案

### 7.1 Milestone 1: Core minimum

- config 読み込み(default fallback 方式)と `config/default.jsonc`
- HTTP listener の透過転送(4.1 の proxy 基盤動作、HTTP/1.1 / h2c)
- upstream 障害時の応答生成
- 管理 API 基盤(共通仕様、healthz live/ready、status)
- rule CRUD with hot load、revision / expectedRevision
- HTTP request matcher(regex / 複合)
- `mock_response` / `fault`(http_response / connection / timeout)
- delay(fixed)
- 消費型 rule(times / resetAfterMs、exhausted 時の次 rule 評価)
- traffic metadata log と capture / intercepted body log 保存
- log API(list / detail / delete)

### 7.2 Milestone 2: Response 段階と UI

- `response.match` と response 段階の評価
- `response_replace`(header regex 置換)
- response 段階 fault
- delay `total` mode
- request / upstream response / returned response の差分 log
- `rules:simulate`(logIds / sampleRequest)
- import / export
- mask preset と Masking API
- SSE realtime log
- UI(React SPA): Dashboard / Rules / Rule Editor(simple / advanced)/ Logs / Settings

### 7.3 Milestone 3: gRPC unary

- gRPC listener と gRPC path / metadata matcher
- `grpc_status` fault
- descriptor registry と validation
- gRPC unary mock response(descriptor 必須)
- gRPC body logging / log detail
- UI: gRPC Descriptors 画面、grpcurl 生成

### 7.4 Milestone 4: Script と streaming

- script matcher / script manipulator(sandbox subprocess、rule ごとの timeout)
- UI Rule Editor script mode
- gRPC streaming: metadata / trailer / grpc-status の inspect / edit、delay、grpc_status fault
- streaming body passthrough の安定化
- retention manager
- metrics
- performance limits(max connections / streams)

## 8. Acceptance Criteria

基盤動作:

- ルール未設定時、HTTP request は upstream に透過転送される(header / body / status を変換しない)
- ルール未設定時、gRPC request は upstream に透過転送される
- upstream への接続失敗時、HTTP では `502`、gRPC では `grpc-status: 14` が返り、traffic log に `outcome: "upstream_error"` が記録される
- config file なしで app が起動し、hard coded default で動作する
- config の一部 key が invalid な場合、その key だけ default に fallback して起動し、warning が application log に出る

CONNECT egress(4.14):

- `mode: "connect"` の listener が HTTP CONNECT を受理し、client の下流アドレス設定を変更せずに
  トンネル内の traffic を透過転送できる
- CONNECT authority がその接続の upstream になり、traffic log の `target` に記録される
- 1 つの connect listener で複数の異なる下流宛先を同時に扱える
- connect listener 上でも rule(capture / fault / mock / manipulation / consume)が reverse
  listener と同様に適用される
- CONNECT 以外の request を受けた場合は `405` を返す

Rule / hot load:

- 管理 API から rule を登録すると、再起動なしで次 request から反映される
- 管理 API から rule を削除すると、次 request から反映されなくなる
- `expectedRevision` が古い更新要求は `409` で拒否される
- HTTP path regex rule で mock response を返せる
- HTTP response header の regex 置換 rule(`response_replace`)を設定できる
- gRPC method matcher で grpc-status fault を返せる
- `response.match` により、upstream response の内容(HTTP status / grpc-status)を条件に response 段階の action を適用できる

消費型:

- 消費型 rule で最初の N 回だけ適用し、N+1 回目からは適用されない
- 同じ matcher に一致する priority の異なる 2 つの rule がある場合、priority の高い rule が消費しきった後は priority の低い rule が適用される
- どの rule にも一致しない場合は passthrough する
- `resetAfterMs` 経過後に counter が初期化され、再び適用される

Delay:

- response 段階の delay(fixed)で指定時間の遅延が追加される
- response 段階の delay(total)で、request 受理から response 返却開始までの合計時間が指定時間になる。upstream 所要時間が既に指定時間を超えている場合は追加遅延なしで返し、log に記録される

Logging / simulation:

- unmatched passthrough traffic は traffic log に保存されない
- capture / intercepted traffic の request と returned response は body log policy に従って保存される
- fault injection / mock で生成した response も log に保存される
- response manipulation された場合、upstream response と returned response が保存される
- capture 用 rule で対象 traffic を passthrough しながら body logging できる
- 管理 API で既存 log または sample request に rule を適用した場合の simulation を確認できる
- body を使った simulation は capture 済み log を入力にして実行できる
- mask 設定が log の header / JSON body preview に適用され、Masking API で起動後に変更できる

gRPC:

- gRPC body log / body manipulation は descriptor または `.proto` がある場合だけ許可される
- gRPC streaming で metadata / trailer / grpc-status の inspect / edit ができ、message body は passthrough される

Script:

- script matcher / manipulator の timeout は既定 3 秒で、rule ごとに変更できる
- script error / timeout 時は req/resp を編集せず passthrough し、traffic log と application log に記録される

Import / export:

- rule set(script source を含む)を export し、別プロセスに import して同じ挙動を再現できる

管理 API / UI:

- 管理 API で rule 一覧、rule state、log 一覧、log 詳細を確認できる
- `healthz/live` と `healthz/ready` が区別され、listener bind 完了前は `ready` が `503` を返す
- UI で rule 一覧、log 一覧、manual matcher / manipulator 登録ができる
- UI で revision conflict を検知し、古い rule set をベースにした保存を拒否できる
- UI で実行できるすべての操作は管理 API 単体でも実行できる
