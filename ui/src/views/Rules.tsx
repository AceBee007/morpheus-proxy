import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Rule, type RuleListItem } from '../api.ts';
import { useToast } from '../toast.tsx';
import { RuleEditor } from './RuleEditor.tsx';

function summarizeMatch(match: unknown): string {
  if (typeof match !== 'object' || match === null) return '';
  const m = match as Record<string, unknown>;
  if (m['type'] === 'regex') return `${m['field']} ~ /${m['pattern']}/`;
  if (m['type'] === 'all' || m['type'] === 'any') return `${m['type']}(${(m['conditions'] as unknown[])?.length ?? 0})`;
  if (m['type'] === 'script') return 'script';
  if (m['type'] === 'not') return 'not(...)';
  return String(m['type']);
}

function summarizeAction(rule: Rule): string {
  const parts: string[] = [];
  const req = rule.request as { action?: { type?: string }; delay?: unknown } | undefined;
  const resp = rule.response as { action?: { type?: string }; delay?: unknown } | undefined;
  if (req?.action?.type) parts.push(`req:${req.action.type}`);
  else if (req?.delay) parts.push('req:delay');
  if (resp?.action?.type) parts.push(`resp:${resp.action.type}`);
  else if (resp?.delay) parts.push('resp:delay');
  if (rule.logging.capture) parts.push('capture');
  return parts.join(', ') || '—';
}

export function Rules(): JSX.Element {
  const toast = useToast();
  const [items, setItems] = useState<RuleListItem[]>([]);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<{ rule: Rule | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const data = await api.listRules();
      setItems(data.items);
      setRevision(data.revision);
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleEnabled = async (item: RuleListItem): Promise<void> => {
    try {
      const { state: _state, ...rest } = item;
      void _state;
      await api.updateRule(item.rule.id, { ...rest.rule, enabled: !item.rule.enabled }, revision);
      await reload();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (!confirm(`Delete rule ${id}?`)) return;
    try {
      await api.deleteRule(id, revision);
      toast('ok', `Deleted ${id}`);
      await reload();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const resetState = async (id: string): Promise<void> => {
    try {
      await api.resetState(id);
      toast('ok', `Reset state for ${id}`);
      await reload();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const duplicate = (rule: Rule): void => {
    const copy = { ...rule, id: `${rule.id}-copy`, name: `${rule.name} (copy)` } as Record<string, unknown>;
    delete copy['createdAt'];
    delete copy['updatedAt'];
    setEditing({ rule: copy as unknown as Rule });
  };

  const disableAll = async (): Promise<void> => {
    if (!confirm('Disable all rules?')) return;
    try {
      const result = await api.disableAll(revision);
      toast('ok', `Disabled ${result.disabled} rules`);
      await reload();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const doExport = async (): Promise<void> => {
    try {
      const data = await api.exportRules();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'morpheus-rules.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const doImport = async (file: File): Promise<void> => {
    try {
      const parsed = JSON.parse(await file.text()) as { rules?: unknown[] };
      const rules = parsed.rules ?? parsed;
      const result = await api.importRules({ mode: 'merge', rules });
      toast('ok', `Imported ${result.imported} rules`);
      await reload();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Rules</h2>
        <span className="muted">revision {revision}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => setEditing({ rule: null })}>New rule</button>
        <button className="btn ghost" onClick={doExport}>Export</button>
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>Import</button>
        <button className="btn danger" onClick={disableAll}>Disable all</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void doImport(file);
            e.target.value = '';
          }}
        />
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th></th><th>Priority</th><th>Name / ID</th><th>Proto</th><th>Matcher</th>
              <th>Action</th><th>Hits</th><th>Remaining</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.rule.id}>
                <td>
                  <span
                    className="toggle"
                    onClick={() => void toggleEnabled(item)}
                    title={item.rule.enabled ? 'enabled' : 'disabled'}
                  >
                    <span className={`status-dot ${item.rule.enabled ? 'on' : 'off'}`} />
                  </span>
                </td>
                <td className="mono">{item.rule.priority}</td>
                <td>
                  <div>{item.rule.name || <span className="muted">(unnamed)</span>}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>{item.rule.id}</div>
                </td>
                <td><span className="tag">{item.rule.protocol}</span></td>
                <td className="mono" style={{ fontSize: 12 }}>{summarizeMatch(item.rule.match)}</td>
                <td className="mono" style={{ fontSize: 12 }}>{summarizeAction(item.rule)}</td>
                <td>{item.state.hits}</td>
                <td>{item.state.remaining ?? '∞'}</td>
                <td>
                  <div className="pill-row">
                    <button className="btn ghost" onClick={() => setEditing({ rule: item.rule })}>Edit</button>
                    <button className="btn ghost" onClick={() => duplicate(item.rule)}>Dup</button>
                    <button className="btn ghost" onClick={() => void resetState(item.rule.id)}>Reset</button>
                    <button className="btn danger" onClick={() => void remove(item.rule.id)}>Del</button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={9} className="muted">No rules. Traffic passes through untouched.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <RuleEditor
          initial={editing.rule}
          revision={revision}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}
