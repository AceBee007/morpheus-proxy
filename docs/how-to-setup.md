# 既存サービスの dev 環境に morpheus-proxy を導入する手順

このドキュメントは、Istio mesh 上で動く既存マイクロサービス(以下 app)の **dev 環境** に
morpheus-proxy を追加し、**app が下流サービスへ出す request / 下流からの response を
inspect / manipulate できるようにする**手順をまとめたものです。
demo の `ms-a` への導入実績を一般化しています(GKE + Istio 実機での検証記録は
[verification-matrix.md](verification-matrix.md) と [tmp/setup-morpheus-proxy-worklog.md](../tmp/setup-morpheus-proxy-worklog.md))。

> **対象は dev 環境のみ。** morpheus は認証を持たず、admin API から挙動を自由に変えられます。
> 本番・ステージングには入れないでください。

## 1. 仕組み(CONNECT 方式)

morpheus はサービス Pod に**もう 1 つのコンテナ**として同居する proxy です。
標準の導入方式は **CONNECT 方式**(spec 4.14): app は client の proxy 設定で morpheus を指し、
**下流アドレスは一切変えません**。

```
app ──(proxy設定: CONNECT)──▶ morpheus 127.0.0.1:15052 ──▶ istio-proxy ──(mTLS)──▶ 下流サービス
                                   └── CONNECT の宛先(ms-b:50052 等)を読み、
                                       rule pipeline(inspect/mock/fault/改変/capture)を通して転送
```

ポイント:

- **既存のネットワーク設定はそのまま**: Service / targetPort / Istio 設定 / 下流アドレスは無変更。
  変えるのは「app に proxy 設定の env を 1 つ足す」「Pod に morpheus コンテナと ConfigMap を足す」だけ
- **1 listener で複数下流**: 宛先は CONNECT の authority(`ms-b:50052`)から分かるため、
  下流が ms-b / ms-c / ms-d と増えても listener は 1 つでよい
- **ルールが無ければ素通し**(透過転送)。既存の挙動は変わらない。ルールを入れると
  mock / fault injection / delay / body 改変 / capture ができる
- app → morpheus は Pod 内 loopback なので Istio に捕捉されず、morpheus → 下流は Pod を
  出るので**従来どおり istio-proxy が mTLS 化**する(実機で envoy stats により確認済み)
- **inbound(app が呼ばれる側)は対象外**: この手順では app に到達する request には一切触れない。
  必要になった場合の reverse 方式は付録 A を参照

前提:

- サービスは Istio sidecar injection 済み(`sidecar.istio.io/inject: "true"`)
- **app の gRPC/HTTP client が CONNECT proxy 設定を尊重できる**(§5。多くの言語で標準サポート、
  または数行の dialer 追加。これが唯一の app 側変更)
- morpheus image を pull できる Artifact Registry がある

## 2. image を用意する

morpheus の image をサービスと同じ Artifact Registry に push します。
GKE ノードが pull できれば追加の IAM は不要です(同 project の registry は通常 pull 可能)。

```sh
# リポジトリのルートで。VPN 接続下で実行（社内ネットワークからレジストリへ到達するため）
REPO=asia-northeast1-docker.pkg.dev/<PROJECT_ID>/<REPO>
IMG=$REPO/morpheus-proxy:latest

gcloud auth configure-docker asia-northeast1-docker.pkg.dev --quiet
docker build --platform linux/amd64 -t "$IMG" .   # GKE ノードは amd64
docker push "$IMG"
```

> Cloud Build (`gcloud builds submit`) が使えるならそちらでも可。ただし tmp / 制限付き
> project では Cloud Build SA に cloudbuild バケットの read 権限が無く失敗することがあります
> (その場合はローカルビルド + push が確実)。

pull できず `ImagePullBackOff (403)` になる場合のみ、ノードの SA に権限を付与します（**IAM 変更なので必ず承認を得てから**）。

```sh
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"
```

## 3. ConfigMap（morpheus の設定）

CONNECT 方式の listener は 1 つだけです。`mode: "connect"` を指定し、`upstream` は書きません
(CONNECT の宛先がそのまま転送先になります)。`host` は Pod 内の app からのみ使うため
loopback に固定します。

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: morpheus-proxy-config
  namespace: <NAMESPACE>
data:
  morpheus.jsonc: |
    {
      "admin": { "host": "0.0.0.0", "port": 18081, "basePath": "/_morpheus" },
      "listeners": [
        // app の下流呼び出し(gRPC)をまとめて受ける CONNECT egress listener
        { "name": "grpc-egress", "protocol": "grpc", "host": "127.0.0.1", "port": 15052,
          "mode": "connect" }
        // 下流に REST(HTTP) もある場合は protocol http の connect listener を別ポートで追加:
        // { "name": "http-egress", "protocol": "http", "host": "127.0.0.1", "port": 15053,
        //   "mode": "connect" }
      ],
      // 下流が gRPC server reflection を公開していれば、descriptor は morpheus が
      // 下流から自動取得する(spec 4.7.6)。手動の proto 登録は不要になる
      "reflection": { "auto": true },
      "logging": { "trafficLogDir": "/tmp/morpheus/traffic", "appLogDir": "/tmp/morpheus/app" }
    }
```

- `name` と `port` は listener ごとに一意にしてください
- 設定できる全 key と既定値は [config/default.jsonc](../config/default.jsonc) を参照してください。
  このファイルは既定値のリファレンスで、アプリが読み込むことはありません(書かなかった key はその既定値で動きます)
- 恒久的に効かせたいルールがある場合は `rules.presets`（配列、要素は rule 定義）に書けます。
  ルールは on-memory で Pod 再起動時に消えるため、常設ルールは presets、実験は admin API を使い分けます
- gRPC の body(message)を扱うルールには descriptor が必要です(spec 4.7)。下流が server reflection を
  公開していれば `reflection.auto: true` で自動取得され(最初の 1 リクエストは素通し、以降は decode 可)、
  起動時に確実に揃えたい下流は `"descriptors": [{ "reflect": "<downstream>:<port>" }]` と書きます。
  reflection が無い下流だけ、descriptor set / `.proto` を admin API で登録します(api-manual §13)

## 4. Deployment にサイドカーを追加

app の Deployment に morpheus コンテナと ConfigMap volume を追加します。
公開が必要なポートは admin (18081) だけです(CONNECT listener は loopback 専用)。

```yaml
spec:
  template:
    spec:
      containers:
        - name: <app>            # 変更は §5 の env 追加のみ
          # ...
        - name: morpheus-proxy   # ← 追加
          image: asia-northeast1-docker.pkg.dev/<PROJECT_ID>/<REPO>/morpheus-proxy:latest
          imagePullPolicy: Always
          env:
            - name: MORPHEUS_CONFIG
              value: /etc/morpheus/morpheus.jsonc
          ports:
            - { name: mp-admin, containerPort: 18081 }   # admin API / Web UI
            # connect listener(15052)は loopback 専用なので containerPort に出さない
          readinessProbe:
            httpGet: { path: /_morpheus/healthz/ready, port: 18081 }
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /_morpheus/healthz/live, port: 18081 }
            initialDelaySeconds: 5
            periodSeconds: 20
          volumeMounts:
            - { name: morpheus-config, mountPath: /etc/morpheus }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 256Mi }
      volumes:
        - name: morpheus-config
          configMap: { name: morpheus-proxy-config }
```

Service は**変更しません**(admin/UI を in-cluster から触りたい場合のみ、任意で
`{ name: mp-admin, port: 18081, targetPort: 18081 }` を足す)。

## 5. app に proxy 設定を足す(唯一の app 側変更)

app の下流アドレス(`MS_B_ADDR` 等)は**据え置き**のまま、gRPC client の dial を
morpheus の CONNECT listener 経由にします。

```yaml
# app コンテナの env: 下流アドレスは変えず、proxy 設定を 1 つ足すだけ
env:
  - name: GRPC_PROXY_ADDR        # ← 追加(名前は app の実装に合わせる)
    value: "127.0.0.1:15052"
  - name: MS_B_ADDR              # 変更なし。CONNECT の宛先 = 転送先になる
    value: "ms-b:50052"
  - name: MS_C_ADDR              # 変更なし。同じ morpheus が全下流を傍受する
    value: "ms-c:50053"
```

client 側の実装は 2 通りあります:

1. **専用 env + dialer(推奨)**: 対象の gRPC client にだけ CONNECT dialer を差す。
   grpc-go なら `grpc.WithContextDialer` で CONNECT する数行の dialer
   (実装例: [demo/cmd/ms-a/main.go](../demo/cmd/ms-a/main.go) の `connectProxyDialer`)。
   効かせる client を明示的に選べるため、外部 TLS client を巻き込む事故がない
2. **言語標準の proxy env**: grpc-go / Go `net/http` / `@grpc/grpc-js` などは
   `HTTPS_PROXY`(または `grpc_proxy`)を尊重する。コード変更ゼロだが **process 全体に
   効く**ため、Spanner / GCS など外部 TLS 宛先を必ず `NO_PROXY` で除外すること
   (除外しないとそれらの接続が失敗する。§8 制約参照)

## 6. 適用とロールアウト確認

```sh
CTX=<kube-context>
kubectl --context=$CTX apply -f <your-manifest>.yaml
kubectl --context=$CTX -n <NAMESPACE> rollout status deploy/<app>
# Pod が app + istio-proxy + morpheus-proxy で N+1 コンテナ（例 3/3）になれば成功
```

demo の完成形マニフェスト(CONNECT 方式、GKE + Istio で検証済み)は
[demo/k8s/ms-a-morpheus-connect.yaml](../demo/k8s/ms-a-morpheus-connect.yaml) を参照。
docker compose で動くローカル版は [demo/README.md](../demo/README.md)。

> `demo/k8s/*.yaml` の image は project 部分を `${GCP_PROJECT_ID}` で参照しています。適用前に
> 自分の project id で展開してください:
>
> ```sh
> export GCP_PROJECT_ID=<your-project-id>
> envsubst < demo/k8s/ms-a-morpheus-connect.yaml | kubectl --context=$CTX apply -f -
> ```

## 7. 動作確認

```sh
POD=$(kubectl --context=$CTX -n <NAMESPACE> get pods -l <app-selector> -o jsonpath='{.items[0].metadata.name}')
A=http://localhost:18081/_morpheus/api/v1

# readiness
kubectl --context=$CTX -n <NAMESPACE> exec $POD -c morpheus-proxy -- \
  wget -qO- http://localhost:18081/_morpheus/healthz/ready

# 1) 素通し確認: app を通常どおり使えて挙動が変わらないこと

# 2) capture ルールを入れ、app が下流を呼んだ traffic がログに出ることで
#    「morpheus を通っている」ことを確認(protocol は grpc)
kubectl --context=$CTX -n <NAMESPACE> exec $POD -c morpheus-proxy -- \
  wget -qO- --header='content-type: application/json' \
  --post-data='{"id":"cap","protocol":"grpc","priority":10,"match":{"type":"regex","field":"path","pattern":"^/"},"logging":{"capture":true}}' \
  $A/rules
# → app に下流呼び出しを発生させたあと:
kubectl --context=$CTX -n <NAMESPACE> exec $POD -c morpheus-proxy -- wget -qO- "$A/logs?limit=5"
# 各エントリの "listener":"grpc-egress" と "target":"h2c://<下流>:<port>" を確認

# 2') reflection.auto を有効にしている場合: 下流ごとに descriptor が取り込まれたことを確認
#     (imports に target が並ぶ。failures に unimplemented があればその下流は reflection 非公開)
kubectl --context=$CTX -n <NAMESPACE> exec $POD -c morpheus-proxy -- wget -qO- "$A/grpc/reflection"

# 3) (任意) morpheus → 下流が istio-proxy を通っている証拠: envoy の下流クラスタ統計が増える
kubectl --context=$CTX -n <NAMESPACE> exec $POD -c istio-proxy -- \
  pilot-agent request GET clusters | grep -E '<downstream>.*rq_total'
```

## 8. テストでの使い方（例）

下流 gRPC を「最初の 2 回だけ UNAVAILABLE」にして、app のリトライ/フォールバック挙動を試す:

```sh
kubectl exec $POD -c morpheus-proxy -- wget -qO- --header='content-type: application/json' \
  --post-data='{"id":"downstream-flaky","protocol":"grpc","priority":100,
    "match":{"type":"regex","field":"grpc.service","pattern":"^my.pkg.DownstreamService$"},
    "request":{"action":{"type":"fault","fault":{"kind":"grpc_status","status":14,"message":"injected"}}},
    "consume":{"times":2}}' \
  http://localhost:18081/_morpheus/api/v1/rules
```

(demo では ms-a→ms-b の `TimeService/Now` にこの手法で fault を注入し、ms-a の応答が
最初の 2 回 502、その後正常に戻ることを GKE + Istio 実機で確認済み。)

他に response header の置換(`response_replace`)、response body の改変(`script_manipulator`)、
遅延(`delay`)、mock(`mock_response`)が使えます。gRPC で body を mock / 改変する場合は
descriptor が必要です。下流が reflection を公開していれば `reflection.auto` で自動取得されるか、
`POST /_morpheus/api/v1/grpc/descriptors:reflect` に `{"target":"<downstream>:<port>"}` を投げて
明示的に取り込めます。reflection が無い下流は `POST /_morpheus/api/v1/grpc/descriptors` に
descriptor set / `.proto` を登録します(詳細は [docs/spec.md](spec.md) の 4.5 / 4.7、api-manual §13)。

admin API / Web UI をローカルから触るには port-forward:

```sh
kubectl --context=$CTX -n <NAMESPACE> port-forward $POD 18081:18081
# ブラウザで http://localhost:18081/_morpheus/ （React UI）
```

### admin API 操作の注意

- morpheus コンテナは Node イメージで、`wget`(busybox)には **DELETE がありません**。
  ルール削除など DELETE 系は同梱の node で:
  ```sh
  kubectl exec $POD -c morpheus-proxy -- \
    node -e "fetch('http://localhost:18081/_morpheus/api/v1/rules/ID',{method:'DELETE'}).then(r=>console.log(r.status))"
  ```
- port-forward 経由なら手元の `curl` で全メソッド使えます。

## 9. 撤去(元に戻す)

app の proxy 設定 env(`GRPC_PROXY_ADDR` 等)を外し、Deployment から morpheus コンテナと
ConfigMap volume を外して apply するだけです。下流アドレスも Service も元から触っていないため
他に戻すものはありません。ルールは on-memory なので状態は残りません。

## 10. 制約・注意

- **dev 専用**: 認証なし。Service に admin ポートを載せる場合も mesh 内限定にすること。
- **opt-in**: proxy 設定を入れた client の通信だけが morpheus を通る。設定しない client は
  素通り(傍受されない)。漏れなく捕捉したい要件には `EnvoyFilter` / iptables の透過捕捉が
  必要だが、本 proxy の対象外(spec 2.3)。
- **平文のみ**: トンネル内が client 終端の TLS(外部 SaaS の HTTPS、Spanner / GCS 等)だと
  morpheus は暗号文を改変できず、blind 中継もしないため**その接続は失敗する**。
  外部サービスのテストは emulator / mock を使う。このため proxy 設定は process 全体の
  `HTTPS_PROXY` より**専用 env(`GRPC_PROXY_ADDR` 等)を推奨**。`HTTPS_PROXY` を使う場合は
  外部 TLS 宛先を `NO_PROXY` で除外する(§5)。
- **inbound は対象外**: app に到達する request / app が返す response には触れない(付録 A の
  reverse 方式を明示的に組んだ場合のみ対象になる)。
- **ルールは揮発**: Pod 再起動で消える。常設は `rules.presets`、共有は `rules:export` /
  `rules:import` を使う。
- **body を扱うルールのみバッファリング**: 単純な header/path matcher や素通しでは body を
  読まない(既定 1 MiB 上限、config で変更可)。
- **gRPC の body 操作は descriptor 必須**: 未登録なら metadata / grpc-status のみ扱える。reflection は
  サーバ側 opt-in の機能なので、公開していない下流には効かない(その場合は手動登録)。

## 付録 A: reverse 方式(参考・通常は不要)

morpheus は固定 upstream へ転送する reverse listener も持ちます(spec 3.2)。CONNECT 方式で
足りる限り不要ですが、client に proxy 設定を一切入れられない場合の代替です。

- **outbound(reverse)**: 下流ごとに listener を立て(`"upstream": "h2c://<downstream>:<port>"`)、
  app の下流アドレス env を `127.0.0.1:<listenerPort>` に**書き換える**。下流の数だけ
  listener と env 変更が増える
- **inbound**: Service の `targetPort` を morpheus に向け、morpheus の upstream を
  `127.0.0.1:<appPort>` にする。app に到達する request / app が返す response を挟める
  (本手順のスコープ外)

両方式を混在させることもできます。完成形マニフェスト(inbound http/grpc + reverse outbound
grpc の全部入り)は [demo/k8s/ms-a-morpheus-sidecar.yaml](../demo/k8s/ms-a-morpheus-sidecar.yaml) を参照。
