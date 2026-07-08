# 検証トレーサビリティ・マトリクス

docs/spec.md の各要件について「実装 → unit test → 実機/UI 検証」の対応を示す。

- **Unit**: 該当機能を検証する vitest テスト(合計 236 件 / 19 ファイル、`npm test`)
- **GKE**: GCP `GCP_PROJECT_ID_REDACTED`(ms-a 両方向サイドカー)での実 traffic 検証
- **UI**: playwright-mcp による実デプロイの UI 操作検証

> 注: goal 記載の GKE workspace `GCP_PROJECT_ID_OLD_REDACTED` は期限切れで削除済みのため使用不可。
> 現行の tmp project `GCP_PROJECT_ID_REDACTED`(2026-08-07 頃期限)で検証した。

## spec 4.x トレーサビリティ

| spec | 実装 | Unit test | GKE / UI 実機検証 |
| --- | --- | --- | --- |
| 4.1.1 透過転送 | `src/proxy/pipeline.ts`, `http-listener.ts` | `proxy.integration.test.ts`(transparent forwarding, hop-by-hop, Host 保持) | GKE: ms-b→ms-a /echo が素通しで 200 |
| 4.1.2 upstream 障害応答 | `pipeline.ts`, `upstream.ts` | `proxy.integration.test.ts`(502/504 + x-morpheus-error) | GKE: upstream down → 502(前環境検証、実装同一) |
| 4.1.3 trace id | `pipeline.ts` | (metadata 経路) | — |
| 4.1.4 / 4.9 ログ保存方針 | `logging/traffic-log.ts` | `traffic-log.test.ts` | GKE: unmatched 非記録、capture のみ記録を確認 |
| 4.2.1 共通仕様(error/pagination) | `admin/server.ts`, `http-util.ts` | `admin-api.integration.test.ts`(error shape, cursor) | UI 経由で全 API を使用 |
| 4.2.2 Health live/ready | `admin/server.ts` | admin test | GKE: readinessProbe /healthz/ready が通過 |
| 4.2.3 Status | `admin/server.ts` | admin test | GKE + UI Dashboard で listeners/ruleCount 表示 |
| 4.2.4 Rule CRUD + revision | `admin/rules-api.ts`, `rules/store.ts` | `admin-api.integration.test.ts`, `store.test.ts` | UI: create→list→delete、revision conflict 409 |
| 4.2.5 Rule state / reset | `rules/consume.ts`, `rules-api.ts` | `consume.test.ts`, admin test | GKE: consume state hits/remaining 確認 |
| 4.2.6 Simulation | `admin/simulate.ts` | `admin-api.integration.test.ts`(logIds/sampleRequest/script) | GKE: capture 済み log に draft rule を simulate |
| 4.2.7 Import / Export | `rules-api.ts`, `store.ts` | admin test(round-trip, atomic) | — |
| 4.2.8 Log API + SSE | `admin/logs-api.ts` | admin test(filter/body/export/SSE) | UI: Logs 画面 realtime + detail |
| 4.2.9 Masking API | `logging/mask.ts`, `server.ts` | `mask.test.ts`, admin test | UI: Settings で mask 表示、GKE で編集反映 |
| 4.3 Rule model / evaluation | `rules/validate.ts`, `evaluate.ts` | `validate.test.ts`, `evaluate.test.ts` | GKE: priority/consume の適用順を確認 |
| 4.4.1 regex matcher | `rules/matcher.ts` | `matcher.test.ts` | GKE: path/service matcher で発火 |
| 4.4.2 複合 matcher | `rules/matcher.ts` | `matcher.test.ts`(all/any/not + script nested) | GKE: all(service,metadata) で発火 |
| 4.4.3 script matcher | `script/sandbox.ts` | `sandbox.test.ts`(security/timeout/coercion) | GKE: script matcher + manipulator e2e |
| 4.5.1 Delay(fixed/total) | `proxy/actions.ts` | `actions.test.ts`, `proxy.integration.test.ts` | (local integration) |
| 4.5.2 Fault(http/grpc/conn/timeout) | `pipeline.ts`, `grpc-listener.ts` | proxy/grpc integration | GKE: 消費型 HTTP 503×2、gRPC UNAVAILABLE×2 |
| 4.5.3 Mock response | `pipeline.ts`, `grpc-listener.ts` | proxy/grpc integration | GKE: HTTP mock 222、gRPC unary mock |
| 4.5.4 Request rewrite | `proxy/actions.ts` | `actions.test.ts` | GKE: set_header/set_query 適用、log forwardedRequest.modified |
| 4.5.5 Response replace | `proxy/actions.ts` | `actions.test.ts` | GKE: gRPC metadata 置換(前環境)/ unit |
| 4.5.6 Script manipulator | `script/sandbox.ts`, `proxy/patch.ts` | `patch.test.ts`(http+grpc patch), `sandbox.test.ts` | GKE: inbound HTTP response body 改変(served_by→morpheus-edited)、outbound gRPC |
| 4.6 消費型 rule | `rules/consume.ts` | `consume.test.ts` | GKE: times=2 → 適用 2 回→透過 |
| 4.7.1-4 gRPC unary/path/descriptor/fault | `grpc/*.ts` | `grpc.integration.test.ts`, `descriptors.test.ts` | GKE: descriptor 登録(well-known import)、decoded body capture |
| 4.7.5 gRPC streaming | `grpc/grpc-listener.ts` | `grpc.integration.test.ts`(streaming metadata/trailer/status) | unit(server streaming) |
| 4.8 HTTP handling / body limit | `proxy/body.ts`, `pipeline.ts` | `proxy.integration.test.ts`(413, streaming) | — |
| 4.9.1-3 log event/policy | `logging/traffic-log.ts` | `traffic-log.test.ts` | GKE + UI Logs |
| 4.9.4 Retention | `retention.ts` | `retention.test.ts` | — |
| 4.9.5 Redaction | `logging/mask.ts` | `mask.test.ts` | GKE: authorization→***、$.password→*** をキャプチャログで確認 |
| 4.10 Hot load / rule store | `rules/store.ts`, `pipeline.ts` | `store.test.ts`, `proxy.integration.test.ts`(hot reload) | GKE: rule 追加/削除が再起動なしで反映 |
| 4.11 Safety and limits | `config/*`, `pipeline.ts` | `load.test.ts` | GKE: config 経由の limits/listener |
| 4.12 Observability / metrics | `observability/metrics.ts`, `server.ts` | `admin-api.integration.test.ts`(JSON + Prometheus) | GKE: /api/v1/metrics(JSON)、/_morpheus/metrics(Prometheus) |
| 4.13 Configuration(default fallback) | `config/load.ts`, `defaults.ts` | `load.test.ts`, `defaults.test.ts` | GKE: ConfigMap の JSONC で起動 |
| 4.14 CONNECT egress listener | `proxy/connect-listener.ts`, `config/load.ts` | `connect.integration.test.ts`(HTTP/1.1 透過+mock、gRPC via `grpc_proxy` の consume fault) | GKE(istio クラスタ、ms-a 3/3 = app + istio-proxy + morpheus): `GRPC_PROXY_ADDR` のみ追加(`MS_B_ADDR`/Service targetPort 据置)→ Now + Sound の複数下流呼び出しを 1 listener で capture、consume fault 502×2→回復、envoy `outbound\|50052\|\|ms-b` の rq_total 増分で morpheus→ms-b が istio-proxy 経由と確認 |
| §5 Web UI | `ui/` (React SPA) | UI は playwright で検証(ロジックは backend unit) | UI: Dashboard/Rules/Editor(3 mode)/Logs(SSE)/Descriptors/Settings 全画面 |

## UI 画面別 playwright 検証(GKE 実デプロイ)

| 画面 | 確認内容 |
| --- | --- |
| Dashboard | listeners(http-in/grpc-in/grpc-out-msb)、requestsByOutcome、script sandbox 状態 |
| Rules | 一覧、New rule、revision 表示 |
| Rule Editor | simple/advanced/script の 3 モード、template picker、Format/Validate/Simulate、書き込み経路(create 201→delete 200) |
| Logs | realtime、outbound fault エントリ表示、log detail |
| gRPC Descriptors | 登録フォーム、登録済み service/method 表示 |
| Settings | mask 設定(headers/jsonPaths)表示・保存 |

## アーキテクチャ / Best Practice メモ

- **依存注入**: 各コンポーネント(RuleStore / ConsumeRegistry / TrafficLogStore / MaskRegistry /
  MetricsRegistry / ScriptSandbox / DescriptorRegistry)はコンストラクタ/引数で明示的に注入。
  グローバル状態やシングルトンに依存せず、テストで差し替え可能(`src/testing/harness.ts` が実証)。
- **エラーハンドリング**: 管理 API は `ApiError` で status/code/detail を統一(`http-util.ts`)。
  data plane は upstream 障害を 502/504・gRPC 14/4 に正規化、script error/timeout は
  rule execution failure として passthrough(traffic + app log 記録)。
- **方向非依存 Core**: listener は「受けて upstream に流す」だけで inbound/outbound の区別を持たず、
  config の listener 配列で両方向を構成(spec 3.2)。
- **ログ非同期化**: traffic/app log は非同期書き込みで request 処理をブロックしない。
- **script 隔離**: rule script は別 subprocess の bare `vm` context(require/process/eval/dynamic import 禁止、
  per-rule timeout、freeze 時 respawn)。
- **型/lint**: TypeScript strict + `exactOptionalPropertyTypes`、typescript-eslint recommendedTypeChecked。
  `npm run check`(tsc + eslint)/ `check:ui` で backend/UI とも検証。
