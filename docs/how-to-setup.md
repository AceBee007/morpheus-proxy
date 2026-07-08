# 既存サービスの dev 環境に morpheus-proxy を導入する手順

このドキュメントは、Istio mesh 上で動く既存マイクロサービスの **dev 環境** に
morpheus-proxy を「inbound サイドカー」として追加する手順をまとめたものです。
demo の `ms-a` への導入実績([tmp/setup-morpheus-proxy-worklog.md](../tmp/setup-morpheus-proxy-worklog.md))を一般化しています。

> **対象は dev 環境のみ。** morpheus は認証を持たず、admin API から挙動を自由に変えられます。
> 本番・ステージングには入れないでください。

## 1. 仕組み(何をするか)

morpheus はサービス Pod に**もう 1 つのコンテナ**として同居し、Service の受け口
(`targetPort`)を morpheus に向けます。inbound はこう流れます。

```
peer service ──(mTLS)──▶ istio-proxy (sidecar) ──▶ morpheus :18080/:15051 ──▶ app 127.0.0.1:<port>
```

- ルールが無ければ morpheus は**素通し**(透過転送)。既存の挙動は変わりません。
- ルールを入れると、mock / fault injection / delay / body 改変 / capture ができます。
- morpheus → app は Pod 内の loopback(`127.0.0.1`)なので Istio に捕捉されません。
- app → 他サービス(outbound)は従来どおり Istio 経由。morpheus は **inbound のみ**挟みます。

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

app の listen ポートを `upstream` に、morpheus の listen ポートを `18080`(HTTP)/`15051`(gRPC)にします。
HTTP だけ、あるいは gRPC だけのサービスなら、その listener だけ書けば十分です。

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
        { "name": "http", "protocol": "http", "host": "0.0.0.0", "port": 18080,
          "upstream": "http://127.0.0.1:8080" },
        { "name": "grpc", "protocol": "grpc", "host": "0.0.0.0", "port": 15051,
          "upstream": "h2c://127.0.0.1:50051" }
      ],
      "logging": { "trafficLogDir": "/tmp/morpheus/traffic", "appLogDir": "/tmp/morpheus/app" }
    }
```

恒久的に効かせたいルールがある場合は `rules.presets`（配列、要素は rule 定義）に書けます。
ルールは on-memory で Pod 再起動時に消えるため、常設ルールは presets、実験は admin API を使い分けます。

## 4. Deployment にサイドカーを追加

app の Deployment に morpheus コンテナと ConfigMap volume を追加します。
**app コンテナ側のポートや env は変更しません**（morpheus が loopback で app に転送するため）。

```yaml
spec:
  template:
    spec:
      containers:
        - name: <app>            # 既存のまま
          # ... 変更なし ...
        - name: morpheus-proxy   # ← 追加
          image: asia-northeast1-docker.pkg.dev/<PROJECT_ID>/<REPO>/morpheus-proxy:latest
          imagePullPolicy: Always
          env:
            - name: MORPHEUS_CONFIG
              value: /etc/morpheus/morpheus.jsonc
          ports:
            - { name: mp-http,  containerPort: 18080 }
            - { name: mp-admin, containerPort: 18081 }
            - { name: mp-grpc,  containerPort: 15051 }
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

## 5. Service の targetPort を morpheus に向ける

これが「サービスの受け口を morpheus に差し替える」肝の変更です。`port`（サービスが公開する番号）は
そのまま、`targetPort` を morpheus のポートに変えます。

```yaml
spec:
  ports:
    - { name: http, port: 8080,  targetPort: 18080 }   # app 8080 → morpheus 18080
    - { name: grpc, port: 50051, targetPort: 15051 }   # app 50051 → morpheus 15051
    - { name: mp-admin, port: 18081, targetPort: 18081 }  # 任意: admin/UI を in-cluster 公開
```

> gRPC の Service ポート名は Istio が HTTP/2 と認識できるよう `grpc`（または `grpc-*`）にしてください。

demo の完成形マニフェストは [demo/k8s/ms-a-morpheus-sidecar.yaml](../demo/k8s/ms-a-morpheus-sidecar.yaml) を参照。

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

Service の `targetPort` を app のポートに戻し、Deployment から morpheus コンテナと
ConfigMap volume を外して apply するだけです。ルールは on-memory なので状態は残りません。

## 10. 制約・注意

- **dev 専用**: 認証なし。Service に admin ポートを載せる場合も mesh 内限定にすること。
- **inbound のみ**: outbound(app → 他サービス)は素通し。outbound を挟みたい場合は
  呼び先サービス側に morpheus を入れる。
- **ルールは揮発**: Pod 再起動で消える。常設は `rules.presets`、共有は `rules:export` /
  `rules:import` を使う。
- **body を扱うルールのみバッファリング**: 単純な header/path matcher や素通しでは body を
  読まない(既定 1 MiB 上限、config で変更可)。
- **gRPC の body 操作は descriptor 必須**: 未登録なら metadata / grpc-status のみ扱える。
