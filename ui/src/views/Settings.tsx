import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useToast } from '../toast.tsx';

export function Settings(): JSX.Element {
  const toast = useToast();
  const [headers, setHeaders] = useState('');
  const [jsonPaths, setJsonPaths] = useState('');
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);

  const reload = useCallback(async () => {
    try {
      const [mask, st] = await Promise.all([api.getMask(), api.status()]);
      setHeaders(mask.headers.join('\n'));
      setJsonPaths(mask.jsonPaths.join('\n'));
      setStatus(st);
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveMask = async (): Promise<void> => {
    try {
      const result = await api.setMask({
        headers: headers.split('\n').map((s) => s.trim()).filter(Boolean),
        jsonPaths: jsonPaths.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      setHeaders(result.headers.join('\n'));
      setJsonPaths(result.jsonPaths.join('\n'));
      toast('ok', 'Mask settings saved');
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const retention = (status?.['logRetention'] as Record<string, unknown>) ?? {};

  return (
    <div>
      <h2>Settings</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Redaction / masking</h3>
        <p className="muted">
          Applied to logged headers, JSON body previews, and decoded gRPC bodies. Editable at
          runtime; resets to the config preset on restart.
        </p>
        <div className="split">
          <div className="field">
            <label>Masked headers (one per line)</label>
            <textarea rows={6} value={headers} onChange={(e) => setHeaders(e.target.value)} />
          </div>
          <div className="field">
            <label>Masked JSON paths (one per line)</label>
            <textarea rows={6} value={jsonPaths} onChange={(e) => setJsonPaths(e.target.value)} />
          </div>
        </div>
        <button className="btn" onClick={saveMask}>Save mask settings</button>
      </div>

      <div className="split">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Log retention</h3>
          <pre>{JSON.stringify(retention, null, 2)}</pre>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Script sandbox</h3>
          <pre>{JSON.stringify(status?.['scriptSandbox'] ?? {}, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
