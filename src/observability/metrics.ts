const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export interface MetricsSnapshot {
  requestsByOutcome: Record<string, number>;
  ruleHits: Record<string, number>;
  faultInjections: number;
  scriptErrors: number;
  /** reflection descriptor imports by result: `success` or a failure reason (spec 4.7.6). */
  reflectionImports: Record<string, number>;
  upstreamLatency: {
    bucketsMs: number[];
    counts: number[];
    /** overflow bucket (> last bucket) */
    inf: number;
    totalMs: number;
    count: number;
  };
}

/**
 * In-process metrics (spec 4.12). Exposed as JSON on the admin API and in
 * Prometheus text format on /_morpheus/metrics.
 */
export class MetricsRegistry {
  private requestsByOutcome = new Map<string, number>();
  private ruleHits = new Map<string, number>();
  private faultInjections = 0;
  private scriptErrors = 0;
  private reflectionImports = new Map<string, number>();
  private latencyCounts = new Array<number>(LATENCY_BUCKETS_MS.length).fill(0);
  private latencyInf = 0;
  private latencyTotalMs = 0;
  private latencyCount = 0;

  recordRequest(outcome: string, matchedRuleIds: string[], upstreamMs?: number): void {
    this.requestsByOutcome.set(outcome, (this.requestsByOutcome.get(outcome) ?? 0) + 1);
    for (const id of matchedRuleIds) {
      this.ruleHits.set(id, (this.ruleHits.get(id) ?? 0) + 1);
    }
    if (outcome === 'fault') this.faultInjections += 1;
    if (upstreamMs !== undefined) {
      this.latencyTotalMs += upstreamMs;
      this.latencyCount += 1;
      const index = LATENCY_BUCKETS_MS.findIndex((bucket) => upstreamMs <= bucket);
      if (index === -1) {
        this.latencyInf += 1;
      } else {
        this.latencyCounts[index] = (this.latencyCounts[index] ?? 0) + 1;
      }
    }
  }

  recordScriptError(): void {
    this.scriptErrors += 1;
  }

  recordReflectionImport(result: string): void {
    this.reflectionImports.set(result, (this.reflectionImports.get(result) ?? 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    return {
      requestsByOutcome: Object.fromEntries(this.requestsByOutcome),
      ruleHits: Object.fromEntries(this.ruleHits),
      faultInjections: this.faultInjections,
      scriptErrors: this.scriptErrors,
      reflectionImports: Object.fromEntries(this.reflectionImports),
      upstreamLatency: {
        bucketsMs: [...LATENCY_BUCKETS_MS],
        counts: [...this.latencyCounts],
        inf: this.latencyInf,
        totalMs: this.latencyTotalMs,
        count: this.latencyCount,
      },
    };
  }

  toPrometheus(activeConnections: number): string {
    const lines: string[] = [];
    lines.push('# TYPE morpheus_requests_total counter');
    for (const [outcome, count] of this.requestsByOutcome) {
      lines.push(`morpheus_requests_total{outcome="${outcome}"} ${count}`);
    }
    lines.push('# TYPE morpheus_rule_hits_total counter');
    for (const [rule, count] of this.ruleHits) {
      lines.push(`morpheus_rule_hits_total{rule="${rule}"} ${count}`);
    }
    lines.push('# TYPE morpheus_fault_injections_total counter');
    lines.push(`morpheus_fault_injections_total ${this.faultInjections}`);
    lines.push('# TYPE morpheus_script_errors_total counter');
    lines.push(`morpheus_script_errors_total ${this.scriptErrors}`);
    lines.push('# TYPE morpheus_reflection_imports_total counter');
    for (const [result, count] of this.reflectionImports) {
      lines.push(`morpheus_reflection_imports_total{result="${result}"} ${count}`);
    }
    lines.push('# TYPE morpheus_active_connections gauge');
    lines.push(`morpheus_active_connections ${activeConnections}`);
    lines.push('# TYPE morpheus_upstream_latency_ms histogram');
    let cumulative = 0;
    LATENCY_BUCKETS_MS.forEach((bucket, i) => {
      cumulative += this.latencyCounts[i] ?? 0;
      lines.push(`morpheus_upstream_latency_ms_bucket{le="${bucket}"} ${cumulative}`);
    });
    lines.push(
      `morpheus_upstream_latency_ms_bucket{le="+Inf"} ${cumulative + this.latencyInf}`,
    );
    lines.push(`morpheus_upstream_latency_ms_sum ${this.latencyTotalMs}`);
    lines.push(`morpheus_upstream_latency_ms_count ${this.latencyCount}`);
    return `${lines.join('\n')}\n`;
  }
}
