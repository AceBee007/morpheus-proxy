import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { JsonBlock } from '../JsonBlock.tsx';

function Stat({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export function Dashboard({ onNavigate }: { onNavigate: (v: 'logs') => void }): JSX.Element {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [s, m] = await Promise.all([api.status(), api.metrics()]);
        if (alive) {
          setStatus(s);
          setMetrics(m);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const listeners = (status?.['listeners'] as Array<{ name: string; port: number; activeConnections: number }>) ?? [];
  const byOutcome = (metrics?.['requestsByOutcome'] as Record<string, number>) ?? {};
  const totalRequests = Object.values(byOutcome).reduce((a, b) => a + b, 0);

  return (
    <div>
      <h2>Dashboard</h2>
      {error && <div className="card" style={{ borderColor: 'var(--err)' }}>Cannot reach admin API: {error}</div>}
      <div className="grid" style={{ marginBottom: 16 }}>
        <Stat label="Requests seen" value={totalRequests} />
        <Stat label="Faults injected" value={(metrics?.['faultInjections'] as number) ?? 0} />
        <Stat label="Rules" value={(status?.['ruleCount'] as number) ?? 0} />
        <Stat label="Active connections" value={(status?.['activeConnections'] as number) ?? 0} />
        <Stat label="Script errors" value={(metrics?.['scriptErrors'] as number) ?? 0} />
        <Stat label="Rule revision" value={(status?.['ruleRevision'] as number) ?? 0} />
      </div>

      <div className="split">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Listeners</h3>
          <table>
            <thead><tr><th>Name</th><th>Port</th><th>Conns</th></tr></thead>
            <tbody>
              {listeners.map((l) => (
                <tr key={l.name}>
                  <td className="mono">{l.name}</td>
                  <td className="mono">{l.port}</td>
                  <td>{l.activeConnections}</td>
                </tr>
              ))}
              {listeners.length === 0 && <tr><td colSpan={3} className="muted">no listeners</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Requests by outcome</h3>
          <table>
            <tbody>
              {Object.entries(byOutcome).map(([outcome, count]) => (
                <tr key={outcome}>
                  <td><span className={`tag ${outcome}`}>{outcome}</span></td>
                  <td>{count}</td>
                </tr>
              ))}
              {totalRequests === 0 && <tr><td className="muted">no traffic yet</td></tr>}
            </tbody>
          </table>
          <button className="btn ghost" style={{ marginTop: 12 }} onClick={() => onNavigate('logs')}>
            View logs →
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Script sandbox</h3>
        <JsonBlock value={status?.['scriptSandbox'] ?? {}} />
      </div>
    </div>
  );
}
