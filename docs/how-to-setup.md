# 既存サービスの dev 環境に morpheus-proxy を導入する手順

このドキュメントは、Istio mesh 上で動く既存マイクロサービスの **dev 環境** に
morpheus-proxy をサイドカーとして追加する手順をまとめたものです。
demo の `ms-a` への導入実績([tmp/setup-morpheus-proxy-worklog.md](../tmp/setup-morpheus-proxy-worklog.md))を一般化しています。

> **対象は dev 環境のみ。** morpheus は認証を持たず、admin API から挙動を自由に変えられます。
> 本番・ステージングには入れないでください。

## 1. 仕組み(何をするか)

morpheus はサービス Pod に**もう 1 つのコンテナ**として同居する reverse proxy です。
挟む向きは 2 つあり、**目的に応じて選びます**(両方同時も可)。morpheus の Core は
方向の区別を持たず、「listener で受けて upstream に流す」だけです(spec 3.2)。

### inbound(peer → app への通信を挟む)

app が **呼ばれる側** で、外から来る request と app が返す response を扱いたいとき。
Service の受け口(`targetPort`)を morpheus に向けます。

```
peer service ──(mTLS)──▶ istio-proxy ──▶ morpheus :18080/:15051 ──▶ app 127.0.0.1:<appPort>
```

### outbound(app → 下流サービスへの通信を挟む)

app が **呼ぶ側** で、app が下流に出す request と下流からの response を扱いたいとき
(例: 下流の fault injection / mock / 遅延で app の挙動をテストする)。
app の下流呼び先を morpheus(loopback)に向け替えます。

```
app ──▶ morpheus 127.0.0.1:<outPort> ──▶ istio-proxy ──(mTLS)──▶ 下流サービス
```

**どちらを選ぶか**: app の依存先(下流)を制御してテストしたいなら **outbound**。
app 自身への入力や応答を弄りたいなら **inbound**。両方必要なら両方の listener を立てます。

共通の性質:
- ルールが無ければ morpheus は**素通し**(透過転送)。既存の挙動は変わりません。
- ルールを入れると mock / fault injection / delay / body 改変 / capture ができます。
- morpheus ↔ app(inbound)や app → morpheus(outbound)は Pod 内 loopback(`127.0.0.1`)なので
  Istio に捕捉されません。morpheus → 下流(outbound)は Pod を出るので Istio が mTLS 化します。
- listener は「1 listener = 1 upstream」。複数宛先を挟むなら**下流ごとに listener を 1 つ**立て、
  app 側の各宛先をそれぞれの morpheus listener に向けます。

前提:
- サービスは Istio sidecar injection 済み(`sidecar.istio.io/inject: "true"`)
- app の listen ポートが分かっている(例: HTTP `8080`、gRPC `50051`)
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

listener を「どの向きを挟むか」に応じて定義します。各 listener は `port`(morpheus が待ち受ける)と
`upstream`(転送先)の 1:1 対応です。

- **inbound listener**: `upstream` を同一 pod の app(`127.0.0.1:<appPort>`)にする。`host` は `0.0.0.0`
- **outbound listener**: `upstream` を下流サービス(`<downstream>:<port>`)にする。`host` は `127.0.0.1`
  (pod 内の app からのみ使うため loopback に固定)。下流ごとに 1 listener

下記は inbound(http/grpc)+ outbound(下流 gRPC)を全部入れた例。不要な向き・protocol は削ってください。

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
        // inbound: peer → morpheus → app(loopback)
        { "name": "http-in", "protocol": "http", "host": "0.0.0.0", "port": 18080,
          "upstream": "http://127.0.0.1:8080" },
        { "name": "grpc-in", "protocol": "grpc", "host": "0.0.0.0", "port": 15051,
          "upstream": "h2c://127.0.0.1:50051" },
        // outbound: app(loopback) → morpheus → 下流(istio が mTLS 化)
        { "name": "grpc-out-downstream", "protocol": "grpc", "host": "127.0.0.1", "port": 15052,
          "upstream": "h2c://<downstream>:<port>" }
      ],
      "logging": { "trafficLogDir": "/tmp/morpheus/traffic", "appLogDir": "/tmp/morpheus/app" }
    }
```

同じ protocol の listener を別ポートで複数持つのは正当な構成です(inbound gRPC と outbound gRPC など)。
`name` と `port` は listener ごとに一意にしてください。

恒久的に効かせたいルールがある場合は `rules.presets`（配列、要素は rule 定義）に書けます。
ルールは on-memory で Pod 再起動時に消えるため、常設ルールは presets、実験は admin API を使い分けます。

## 4. Deployment にサイドカーを追加

app の Deployment に morpheus コンテナと ConfigMap volume を追加します。

```yaml
spec:
  template:
    spec:
      containers:
        - name: <app>            # inbound のみなら変更なし。outbound を挟むなら env を変更(下記 §6)
          # ...
        - name: morpheus-proxy   # ← 追加
          image: asia-northeast1-docker.pkg.dev/<PROJECT_ID>/<REPO>/morpheus-proxy:latest
          imagePullPolicy: Always
          env:
            - name: MORPHEUS_CONFIG
              value: /etc/morpheus/morpheus.jsonc
          ports:
            - { name: mp-http,  containerPort: 18080 }   # inbound http listener
            - { name: mp-admin, containerPort: 18081 }   # admin/UI
            - { name: mp-grpc,  containerPort: 15051 }   # inbound grpc listener
            # outbound listener(15052 など)は loopback 専用なので containerPort に出さなくてよい
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

## 5. inbound を挟む場合: Service の targetPort を morpheus に向ける

app を「呼ばれる側」として挟むときの変更です。`port`(公開番号)はそのまま、`targetPort` を
morpheus の inbound listener に変えます。**app コンテナ側は変更不要**(morpheus が loopback で app に転送)。

```yaml
spec:
  ports:
    - { name: http, port: 8080,  targetPort: 18080 }   # app 8080 → morpheus 18080
    - { name: grpc, port: 50051, targetPort: 15051 }   # app 50051 → morpheus 15051
    - { name: mp-admin, port: 18081, targetPort: 18081 }  # 任意: admin/UI を in-cluster 公開
```

> gRPC の Service ポート名は Istio が HTTP/2 と認識できるよう `grpc`（または `grpc-*`）にしてください。

## 6. outbound を挟む場合: app の下流呼び先を morpheus に向ける

app を「呼ぶ側」として挟むときの変更です。app が下流サービスを呼ぶ宛先(環境変数や config)を、
morpheus の outbound listener(loopback)に向け替えます。**Service の targetPort は変えません**。

```yaml
# app コンテナの env(例: 下流 ms-b への gRPC 呼び先)
env:
  - name: MS_B_ADDR
    value: "127.0.0.1:15052"     # 元: ms-b:50052 → morpheus outbound listener へ
```

- morpheus 側は §3 の `grpc-out-downstream`(`:15052 → h2c://<downstream>:<port>`)が受けて下流に転送します。
- 下流が複数あるなら、下流ごとに outbound listener を増やし、app の各宛先をそれぞれに向けます。
- app の呼び先が変更できない(ハードコード等)場合は、Istio の `EnvoyFilter` / iptables で
  outbound を morpheus に redirect する高度な方法が必要ですが、dev では env 変更で足りるのが普通です。

inbound と outbound は併用できます(両方の listener を立て、Service targetPort と app env の両方を変更)。

demo の完成形マニフェスト(inbound http/grpc + outbound grpc の全部入り)は
[demo/k8s/ms-a-morpheus-sidecar.yaml](../demo/k8s/ms-a-morpheus-sidecar.yaml) を参照。

## 6. 適用とロールアウト確認

```sh
CTX=<kube-context>
kubectl --context=$CTX apply -f <your-manifest>.yaml
kubectl --context=$CTX -n <NAMESPACE> rollout status deploy/<app>
# Pod が app + istio-proxy + morpheus-proxy で N+1 コンテナ（例 3/3）になれば成功
```

## 7. 動作確認

```sh
POD=$(kubectl --context=$CTX -n <NAMESPACE> get pods -l <app-selector> -o jsonpath='{.items[0].metadata.name}')
A=http://localhost:18081/_morpheus/api/v1

# readiness
kubectl --context=$CTX -n <NAMESPACE> exec $POD -c morpheus-proxy -- \
  wget -qO- http://localhost:18081/_morpheus/healthz/ready

# 素通し確認: peer から通常どおり呼べる（挙動が変わらない）
# capture ルールを入れて、通過した traffic がログに出るかで「morpheus を通っている」ことを確認
kubectl --context=$CTX -n <NAMESPACE> exec $POD -c morpheus-proxy -- \
  wget -qO- --header='content-type: application/json' \
  --post-data='{"id":"cap","protocol":"http","priority":10,"match":{"type":"regex","field":"path","pattern":"^/"},"logging":{"capture":true}}' \
  $A/rules
# → peer からサービスを呼んだあと:
kubectl --context=$CTX -n <NAMESPACE> exec $POD -c morpheus-proxy -- wget -qO- "$A/logs?limit=5"
```

## 8. テストでの使い方（例）

fault injection で「最初の N 回だけ 503」を再現:

```sh
kubectl exec $POD -c morpheus-proxy -- wget -qO- --header='content-type: application/json' \
  --post-data='{"id":"flaky","protocol":"http","priority":100,
    "match":{"type":"regex","field":"path","pattern":"^/api/orders"},
    "request":{"action":{"type":"fault","fault":{"kind":"http_response","statusCode":503}}},
    "consume":{"times":3}}' \
  http://localhost:18081/_morpheus/api/v1/rules
```

outbound を挟んでいる場合は、**app が下流を呼ぶ通信**に同じルールが効きます。例えば
下流 gRPC を「最初の 2 回だけ UNAVAILABLE」にして、app のリトライ/フォールバック挙動を試せます:

```sh
kubectl exec $POD -c morpheus-proxy -- wget -qO- --header='content-type: application/json' \
  --post-data='{"id":"downstream-flaky","protocol":"grpc","priority":100,
    "match":{"type":"regex","field":"grpc.service","pattern":"^my.pkg.DownstreamService$"},
    "request":{"action":{"type":"fault","fault":{"kind":"grpc_status","status":14,"message":"injected"}}},
    "consume":{"times":2}}' \
  http://localhost:18081/_morpheus/api/v1/rules
```

(demo では ms-a→ms-b の `AnimalSound` にこの手法で fault を注入し、ms-a の応答が
最初の 2 回 502、その後正常に戻ることを確認済み。worklog の「outbound 検証」参照。)

gRPC で `grpc-status` を返す、body を mock する等は descriptor 登録が必要です
(`POST /_morpheus/api/v1/grpc/descriptors` に `.proto` を投入)。詳細は
[docs/spec.md](spec.md) の 4.5 / 4.7 を参照。

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

inbound を挟んでいた場合は Service の `targetPort` を app のポートに戻し、outbound を
挟んでいた場合は app の下流呼び先 env を元の値に戻します。そのうえで Deployment から
morpheus コンテナと ConfigMap volume を外して apply します。ルールは on-memory なので状態は残りません。

## 10. 制約・注意

- **dev 専用**: 認証なし。Service に admin ポートを載せる場合も mesh 内限定にすること。
- **向きは明示的に選ぶ**: inbound は Service targetPort、outbound は app の下流呼び先 env を
  向け替えることで挟む(§5 / §6)。両方向を同時に挟むこともできる。app が mesh を経由せず
  直接 TLS で外部と話す通信(外部 SaaS への HTTPS 等)は Istio でも morpheus でも復号できないため対象外。
- **ルールは揮発**: Pod 再起動で消える。常設は `rules.presets`、共有は `rules:export` /
  `rules:import` を使う。
- **body を扱うルールのみバッファリング**: 単純な header/path matcher や素通しでは body を
  読まない(既定 1 MiB 上限、config で変更可)。
- **gRPC の body 操作は descriptor 必須**: 未登録なら metadata / grpc-status のみ扱える。
