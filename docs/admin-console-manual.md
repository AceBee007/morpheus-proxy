# morpheus-proxy Admin Console 利用ガイド

このガイドは、現行の React admin console と管理 API 実装に基づく Web UI の使い方です。
より細かい API 操作は [api-manual.md](api-manual.md) を参照してください。

## 1. 開き方

admin server の既定 URL は以下です。

```text
http://localhost:18081/_morpheus/
```

Kubernetes 上の morpheus を手元のブラウザで開く場合は、対象 Pod の admin port を port-forward します。

```sh
kubectl --context=<context> -n <namespace> port-forward pod/<pod> 18081:18081
open http://localhost:18081/_morpheus/
```

UI は admin API と同じ origin から配信されます。認証はありません。dev 環境だけで使ってください。

## 2. 共通の考え方

- UI の操作はすべて `/_morpheus/api/v1/*` の管理 API を呼びます。
- rule は on-memory です。再起動で消えるため、残したい rule は Rules 画面の Export で保存します。
- rule 更新時は画面に表示中の revision を `expectedRevision` として送ります。別の画面や API で先に更新されていると保存が拒否されるため、Reload 相当の再表示をしてから再編集してください。
- script rule は sandbox subprocess で実行されます。source は export や log に残るので secret を書かないでください。
- gRPC message body の表示、mock、manipulation には gRPC Descriptors 画面で `.proto` を登録してください。metadata / path / grpc-status の fault は descriptor なしでも使えます。

## 3. Dashboard

Dashboard は 2 秒ごとに `status` と `metrics` を再取得します。

確認できるもの:

- Requests seen
- Faults injected
- Rules
- Active connections
- Script errors
- Rule revision
- listener 一覧と port / active connection
- outcome 別 request 数
- script sandbox 状態

`View logs` を押すと Logs 画面へ移動します。

## 4. Rules

Rules 画面では現在の rule set と revision を確認・編集できます。

一覧の主な列:

- enabled 状態
- priority
- name / id
- protocol
- matcher summary
- request / response action summary
- hits
- remaining

操作:

- `New rule`: Rule Editor を開きます。
- enabled dot: rule の enable / disable を切り替えます。
- `Edit`: JSON editor で既存 rule を編集します。
- `Dup`: `-copy` の id で複製 draft を作ります。保存すると別 rule として作成されます。
- `Reset`: consume state をリセットします。
- `Del`: rule を削除します。
- `Export`: 全 rule を `morpheus-rules.json` として download します。
- `Import`: JSON ファイルを選択して `mode: merge` で import します。
- `Disable all`: 全 rule を `enabled: false` にします。

priority の変更や matcher/action の細かい変更は `Edit` から JSON を編集して保存します。
現行 UI の Export は全件 export です。特定 id だけの export は API を使ってください。

## 5. Rule Editor

Rule Editor は `simple` / `advanced` / `script` の 3 mode を持ちます。現行実装では、どの mode でも最終的には Rule JSON を編集して保存します。

### Simple

新規 rule 作成時に template picker が表示されます。template を選び、必要なパラメータを入力して `Apply template` を押すと JSON draft が生成され、advanced 編集に移ります。

template:

- HTTP 5xx for first N requests
- gRPC UNAVAILABLE for first N requests
- Delay response (fixed)
- Delay response (total)
- Replace response header
- Mock JSON response
- Mock gRPC unary response (needs descriptor)
- Capture traffic

### Advanced

Rule JSON を直接編集します。

ボタン:

- `Format`: JSON を整形します。
- `Validate`: `rules:validate` を実行し、valid / invalid と warnings を表示します。
- `Simulate (sample GET /users/1)`: 編集中 rule を sample request に当てます。sample は `GET /users/1` 固定です。
- `Create rule` / `Save changes`: rule を作成または更新します。

既存 rule の編集では `createdAt` / `updatedAt` は自動で取り除かれた draft が表示されます。

### Script

script matcher / manipulator を含む rule を編集するときに使います。
新規保存時に script を含む JSON だと confirmation が出ます。

例: header が一致したときだけ mock する script matcher。

```json
{
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
}
```

## 6. Logs

Logs 画面では traffic log の一覧、filter、detail、body download、simulation を扱います。
unmatched passthrough traffic は保存されないため、まず Capture traffic rule または intercept rule を入れてから確認してください。

上部操作:

- `Live` / `Paused`: SSE による realtime 受信を pause/resume します。
- `Refresh`: 現在の filter で再取得します。
- `Clear`: 全 log を削除します。

画面上の filter:

- protocol
- outcome
- path contains
- text search

API には method、grpc service/method、rule id、`statusCode` / `grpcStatus`、time range など追加 filter もあります。UI に表示されていない filter は API から使います。

一覧行をクリックすると detail modal が開きます。

Detail で確認できるもの:

- request method / path / headers / body preview
- response status / headers / body preview
- request rewrite 後の forwarded body preview
- response manipulation 前の upstream response preview
- rule errors
- matched rules
- timing

Detail の操作:

- `Simulate current rules on this log`: 現在の rule set をこの log に simulation します。
- `Copy curl` / `Copy grpcurl`: 再現コマンドを clipboard にコピーします。
- `Download request body`: body が保存されている場合だけ表示され、body endpoint を新規タブで開くか download します。
- `Download response body`: body が保存されている場合だけ表示され、body endpoint を新規タブで開くか download します。

body が保存されていない場合は `body not logged` と表示されます。body を保存したいときは capture rule を追加して再度 traffic を流してください。

## 7. gRPC Descriptors

gRPC Descriptors 画面では `.proto` source を登録できます。

手順:

1. `Name` にファイル名や識別名を入れます。
2. `.proto source` に proto 定義を貼ります。
3. `Register` を押します。
4. 登録済み一覧に service / method が表示されることを確認します。

登録済み descriptor は `Delete` で削除できます。

descriptor があると、gRPC unary の body decode、body capture、mock message、message manipulation が使えます。
descriptor がない場合は metadata、path、grpc-status 中心の rule を使ってください。

## 8. Settings

Settings 画面では runtime の redaction / masking を編集できます。

項目:

- Masked headers: 1 行 1 header name
- Masked JSON paths: 1 行 1 JSONPath
- Log retention: status API が返す retention 設定の表示
- Script sandbox: sandbox 状態の表示

`Save mask settings` を押すと現在の mask 設定全体を置き換えます。変更は on-memory で、再起動すると config の `logging.mask` に戻ります。

mask は logged headers、JSON body preview、decoded gRPC body preview に適用されます。raw body file は保存対象を capture / intercepted traffic に限定して扱います。

## 9. 典型的な操作フロー

### Capture してから rule を作る

1. Rules で `New rule` を押します。
2. template から `Capture traffic` を選び、path prefix を入れて `Apply template`。
3. `Validate` して `Create rule`。
4. app から対象 traffic を発生させます。
5. Logs で log detail を開き、request / response を確認します。
6. Rule Editor で mock / fault / rewrite などの rule draft を作ります。
7. `Simulate (sample GET /users/1)` または log detail の `Simulate current rules on this log` で結果を確認します。
8. `Create rule` で hot load します。

### gRPC fault を一時的に入れる

1. Rules で `New rule`。
2. `gRPC UNAVAILABLE for first N requests` template を選びます。
3. service / method / times を入力します。
4. `Validate` して `Create rule`。
5. app の挙動と Rules の hits / remaining、Logs の outcome `fault` を確認します。
6. 終了後は `Reset`、enabled toggle、または `Del` で戻します。

### script manipulator を試す

1. Rules で `New rule`。
2. `script` mode に切り替えます。
3. `response.action.type: "script_manipulator"` を含む JSON を入力します。
4. `Validate` で syntax / schema を確認します。
5. 保存時の confirmation を確認して作成します。
6. Logs の detail で upstream response と returned response を比較します。

## 10. 現行 UI の範囲

現行 console は主要操作を画面化していますが、一部は API から使う形です。

- log の method / grpcService / grpcMethod / ruleId / status / time range filter は API で使えます。
- selected rules export は API の `rules:export` with `ids` を使います。
- log から rule draft を自動生成する UI、rule hit timeline chart はまだ画面にはありません。
- Rule Editor の sample simulation は `GET /users/1` 固定です。任意 sample や保存済み log への draft simulation は API を使うか、Logs detail の current rule simulation を使います。

UI でうまく確認できない細部は、同じ port-forward を使って API manual の curl 手順で確認してください。
