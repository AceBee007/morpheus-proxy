import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type LogEntry } from '../api.ts';
import { useToast } from '../toast.tsx';
import { formatLogTimestamp, resolveTimeZone } from '../time.ts';
import { JsonBlock } from '../JsonBlock.tsx';

const OUTCOMES = [
  '',
  'captured',
  'mock',
  'fault',
  'modified',
  'delayed',
  'upstream_error',
  'rule_error',
  'client_aborted',
];

export function Logs(): JSX.Element {
  const toast = useToast();
  const [items, setItems] = useState<LogEntry[]>([]);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [live, setLive] = useState(true);
  const [filters, setFilters] = useState({ protocol: '', outcome: '', path: '', contains: '' });
  const esRef = useRef<EventSource | null>(null);
  const timeZone = useMemo(() => resolveTimeZone(), []);

  const buildQuery = useCallback((): string => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    params.set('limit', '200');
    return `?${params.toString()}`;
  }, [filters]);

  const reload = useCallback(async () => {
    try {
      const data = await api.listLogs(buildQuery());
      setItems(data.items);
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  }, [buildQuery, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // realtime SSE (spec 5.5.3): pause/resume, server keeps logs while paused
  useEffect(() => {
    if (!live) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }
    const es = new EventSource(api.logEventsUrl());
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data as string) as LogEntry;
        setItems((prev) => [entry, ...prev].slice(0, 200));
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      /* browser auto-reconnects */
    };
    return () => es.close();
  }, [live]);

  const clear = async (): Promise<void> => {
    if (!confirm('Delete all logs?')) return;
    try {
      await api.clearLogs();
      setItems([]);
      setSelected(null);
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Logs</h2>
        <div className="spacer" />
        <button className={`btn ${live ? '' : 'ghost'}`} onClick={() => setLive((v) => !v)}>
          {live ? '● Live' : '▷ Paused'}
        </button>
        <button className="btn ghost" onClick={() => void reload()}>Refresh</button>
        <button className="btn danger" onClick={() => void clear()}>Clear</button>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row">
          <div className="field" style={{ margin: 0 }}>
            <label>Protocol</label>
            <select value={filters.protocol} onChange={(e) => setFilters((f) => ({ ...f, protocol: e.target.value }))}>
              <option value="">any</option><option value="http">http</option><option value="grpc">grpc</option>
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Outcome</label>
            <select value={filters.outcome} onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}>
              {OUTCOMES.map((o) => <option key={o} value={o}>{o || 'any'}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Path contains</label>
            <input value={filters.path} onChange={(e) => setFilters((f) => ({ ...f, path: e.target.value }))} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Text search</label>
            <input value={filters.contains} onChange={(e) => setFilters((f) => ({ ...f, contains: e.target.value }))} />
          </div>
          <div className="spacer" />
          <button className="btn" onClick={() => void reload()}>Apply</button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Time <span className="muted" style={{ fontWeight: 400, textTransform: 'none' }}>({timeZone})</span></th>
              <th>Proto</th><th>Method/Path</th><th>Outcome</th><th>Status</th><th>Dur</th><th>Rules</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id} className="clickable" onClick={() => setSelected(entry)}>
                <td className="mono" style={{ fontSize: 11 }}>{formatLogTimestamp(entry.startedAt, entry.id, timeZone)}</td>
                <td><span className="tag">{entry.protocol}</span></td>
                <td className="mono" style={{ fontSize: 12 }}>{entry.request.method} {entry.request.path}</td>
                <td><span className={`tag ${entry.outcome}`}>{entry.outcome}</span></td>
                <td className="mono">{entry.response.statusCode ?? ''}{entry.response.grpcStatus !== undefined ? ` g${entry.response.grpcStatus}` : ''}</td>
                <td>{entry.durationMs}ms</td>
                <td className="mono" style={{ fontSize: 11 }}>{entry.matchedRules.map((m) => m.id).join(', ')}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={7} className="muted">No logs. Only captured / intercepted traffic is recorded.</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && <LogDetail entry={selected} timeZone={timeZone} onClose={() => setSelected(null)} />}
    </div>
  );
}

function LogDetail({
  entry,
  timeZone,
  onClose,
}: {
  entry: LogEntry;
  timeZone: string;
  onClose: () => void;
}): JSX.Element {
  const [sim, setSim] = useState<string | null>(null);

  const simulate = async (): Promise<void> => {
    try {
      const result = await api.simulate({ logIds: [entry.id] });
      setSim(JSON.stringify(result.results, null, 2));
    } catch (err) {
      setSim(err instanceof Error ? err.message : String(err));
    }
  };

  const curl = buildCurl(entry);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 style={{ margin: 0 }}>Log {formatLogTimestamp(entry.startedAt, entry.id, timeZone)}</h2>
          <span className={`tag ${entry.outcome}`}>{entry.outcome}</span>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <div className="split wrap" style={{ marginTop: 12 }}>
          <div>
            <h4>Request</h4>
            <div className="mono muted" style={{ fontSize: 12 }}>{entry.request.method} {entry.request.path}</div>
            <JsonBlock value={entry.request.headers} />
            {entry.request.bodyLogged ? <JsonBlock value={entry.request.bodyPreview} /> : <div className="muted">body not logged</div>}
            {entry.forwardedRequest?.modified && (
              <>
                <h4>Forwarded (modified)</h4>
                {entry.forwardedRequest.bodyPreview && <JsonBlock value={entry.forwardedRequest.bodyPreview} />}
              </>
            )}
          </div>
          <div>
            <h4>Response</h4>
            <div className="mono muted" style={{ fontSize: 12 }}>
              status {entry.response.statusCode ?? entry.response.grpcStatus}
            </div>
            <JsonBlock value={entry.response.headers} />
            {entry.response.bodyLogged ? <JsonBlock value={entry.response.bodyPreview} /> : <div className="muted">body not logged</div>}
            {entry.upstreamResponse?.bodyPreview && (
              <>
                <h4>Upstream response</h4>
                <JsonBlock value={entry.upstreamResponse.bodyPreview} />
              </>
            )}
          </div>
        </div>

        {entry.ruleErrors && entry.ruleErrors.length > 0 && (
          <div className="field">
            <label>Rule errors</label>
            <JsonBlock value={entry.ruleErrors} />
          </div>
        )}

        <div className="field">
          <label>Matched rules & timing</label>
          <JsonBlock value={{ matchedRules: entry.matchedRules, timing: entry.timing }} />
        </div>

        <div className="row">
          <button className="btn ghost" onClick={simulate}>Simulate current rules on this log</button>
          <button className="btn ghost" onClick={() => { void navigator.clipboard.writeText(curl); }}>Copy {entry.protocol === 'grpc' ? 'grpcurl' : 'curl'}</button>
          {entry.request.bodyLogged && (
            <a className="btn ghost" href={api.logBodyUrl(entry.id, 'request')} target="_blank" rel="noreferrer">Download request body</a>
          )}
          {entry.response.bodyLogged && (
            <a className="btn ghost" href={api.logBodyUrl(entry.id, 'response')} target="_blank" rel="noreferrer">Download response body</a>
          )}
        </div>
        {sim && <JsonBlock value={sim} style={{ marginTop: 12 }} />}
        <div className="field" style={{ marginTop: 12 }}>
          <label>{entry.protocol === 'grpc' ? 'grpcurl' : 'curl'}</label>
          <pre>{curl}</pre>
        </div>
      </div>
    </div>
  );
}

function buildCurl(entry: LogEntry): string {
  if (entry.protocol === 'grpc') {
    const path = (entry.request.path ?? '').replace(/^\//, '');
    const data = entry.request.bodyLogged ? ` -d '${entry.request.bodyPreview ?? ''}'` : '';
    return `grpcurl -plaintext${data} <proxy-host>:<port> ${path}`;
  }
  const headerLines = Object.entries(entry.request.headers)
    .filter(([k]) => !k.startsWith(':'))
    .map(([k, v]) => ` -H '${k}: ${Array.isArray(v) ? v.join(',') : String(v)}'`)
    .join('');
  const body = entry.request.bodyLogged ? ` --data '${entry.request.bodyPreview ?? ''}'` : '';
  return `curl -X ${entry.request.method ?? 'GET'}${headerLines}${body} '<proxy>${entry.request.path ?? '/'}'`;
}
