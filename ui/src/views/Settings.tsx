import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { useToast } from '../toast.tsx';
import { detectBrowserTimeZone, getStoredTimeZone, listSupportedTimeZones, setStoredTimeZone } from '../time.ts';
import { JsonBlock } from '../JsonBlock.tsx';

export function Settings(): JSX.Element {
  const toast = useToast();
  const [headers, setHeaders] = useState('');
  const [jsonPaths, setJsonPaths] = useState('');
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [detected] = useState(() => detectBrowserTimeZone());
  const [savedTz, setSavedTz] = useState<string | null>(() => getStoredTimeZone());
  const [draftTz, setDraftTz] = useState<string>(() => getStoredTimeZone() ?? '');

  const zoneGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const tz of listSupportedTimeZones()) {
      const region = tz.includes('/') ? tz.slice(0, tz.indexOf('/')) : 'Other';
      const list = groups.get(region) ?? [];
      list.push(tz);
      groups.set(region, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, []);

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

  const saveTimezone = (): void => {
    const tz = draftTz || null;
    setStoredTimeZone(tz);
    setSavedTz(tz);
    toast('ok', tz ? `Timezone set to ${tz}` : 'Timezone set to auto-detect');
  };

  const retention = (status?.['logRetention'] as Record<string, unknown>) ?? {};
  const effectiveTz = savedTz ?? detected;
  const effectiveSource = savedTz ? 'saved preference' : 'browser default';

  return (
    <div>
      <h2>Settings</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Timezone</h3>
        <p className="muted">
          Controls how timestamps are displayed in the Logs table. Data sent by the server is
          always UTC; conversion happens in your browser. Saved to this browser's local storage.
        </p>
        <div className="field">
          <label>Display timezone</label>
          <select value={draftTz} onChange={(e) => setDraftTz(e.target.value)}>
            <option value="">{`Auto-detect (${detected})`}</option>
            {zoneGroups.map(([region, zones]) => (
              <optgroup key={region} label={region}>
                {zones.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Currently showing: {effectiveTz} ({effectiveSource})
        </p>
        <button className="btn" onClick={saveTimezone}>Save timezone</button>
      </div>

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
          <JsonBlock value={retention} />
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Script sandbox</h3>
          <JsonBlock value={status?.['scriptSandbox'] ?? {}} />
        </div>
      </div>
    </div>
  );
}
