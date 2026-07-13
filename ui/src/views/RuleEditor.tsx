import { useState } from 'react';
import { api, type Rule } from '../api.ts';
import { useToast } from '../toast.tsx';
import { TEMPLATES } from '../templates.ts';
import { JsonBlock } from '../JsonBlock.tsx';

type Mode = 'simple' | 'advanced' | 'script';

interface Props {
  initial?: Rule | null;
  revision: number;
  onClose: () => void;
  onSaved: () => void;
}

const BLANK = {
  protocol: 'http',
  match: { type: 'regex', field: 'path', pattern: '^/' },
  request: { action: { type: 'mock_response', response: { statusCode: 200, body: '{}' } } },
};

export function RuleEditor({ initial, revision, onClose, onSaved }: Props): JSX.Element {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(initial ? 'advanced' : 'simple');
  const [text, setText] = useState(() =>
    JSON.stringify(initial ? stripServerFields(initial) : BLANK, null, 2),
  );
  const [validation, setValidation] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const parse = (): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      setValidation(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const runValidate = async (): Promise<void> => {
    const rule = parse();
    if (rule === null) return;
    try {
      const result = await api.validateRule(rule);
      setValidation(
        result.valid
          ? `valid${result.warnings.length ? ` (warnings: ${JSON.stringify(result.warnings)})` : ''}`
          : `invalid: ${JSON.stringify(result.errors)}`,
      );
    } catch (err) {
      setValidation(err instanceof Error ? err.message : String(err));
    }
  };

  const runSimulateSample = async (): Promise<void> => {
    const rule = parse();
    if (rule === null) return;
    try {
      const result = await api.simulate({
        sampleRequest: { protocol: (rule as { protocol?: string }).protocol ?? 'http', method: 'GET', path: '/users/1', headers: {} },
        ruleDraft: rule,
      });
      setSimResult(JSON.stringify(result.results, null, 2));
    } catch (err) {
      setSimResult(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async (): Promise<void> => {
    const rule = parse();
    if (rule === null) return;
    setSaving(true);
    try {
      const looksScript = mode === 'script' || JSON.stringify(rule).includes('"script"');
      if (looksScript && !initial) {
        if (!confirm('This rule contains a script that runs in the sandbox. Save it?')) {
          setSaving(false);
          return;
        }
      }
      if (initial) {
        await api.updateRule(initial.id, rule, revision);
        toast('ok', `Rule ${initial.id} updated`);
      } else {
        const created = await api.createRule(rule);
        toast('ok', `Rule ${created.rule.id} created`);
      }
      onSaved();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 style={{ margin: 0 }}>{initial ? `Edit rule ${initial.id}` : 'New rule'}</h2>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <div className="mode-tabs" style={{ marginTop: 12 }}>
          {(['simple', 'advanced', 'script'] as Mode[]).map((m) => (
            <button key={m} className={`btn ${mode === m ? 'active' : 'ghost'}`} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>

        {mode === 'simple' && !initial && (
          <TemplatePicker onPick={(draft) => { setText(JSON.stringify(draft, null, 2)); setMode('advanced'); }} />
        )}

        <div className="field">
          <label>Rule JSON</label>
          <textarea rows={18} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        </div>

        <div className="row">
          <button className="btn ghost" onClick={() => { const r = parse(); if (r) setText(JSON.stringify(r, null, 2)); }}>Format</button>
          <button className="btn ghost" onClick={runValidate}>Validate</button>
          <button className="btn ghost" onClick={runSimulateSample}>Simulate (sample GET /users/1)</button>
          <div className="spacer" />
          <button className="btn" disabled={saving} onClick={save}>{initial ? 'Save changes' : 'Create rule'}</button>
        </div>

        {validation && <JsonBlock value={validation} style={{ marginTop: 12 }} />}
        {simResult && (
          <div className="field" style={{ marginTop: 12 }}>
            <label>Simulation result</label>
            <JsonBlock value={simResult} />
          </div>
        )}
        {mode === 'script' && (
          <p className="muted" style={{ fontSize: 12 }}>
            Script matchers/manipulators run in an isolated subprocess. Source is stored and included in
            exports and logs — do not embed secrets. Default timeout is 3s (override with timeoutMs).
          </p>
        )}
      </div>
    </div>
  );
}

function TemplatePicker({ onPick }: { onPick: (draft: unknown) => void }): JSX.Element {
  const [selected, setSelected] = useState(TEMPLATES[0]?.id ?? '');
  const template = TEMPLATES.find((t) => t.id === selected) ?? TEMPLATES[0];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((template?.params ?? []).map((p) => [p.key, p.default])),
  );

  const pick = (id: string): void => {
    setSelected(id);
    const t = TEMPLATES.find((x) => x.id === id);
    setValues(Object.fromEntries((t?.params ?? []).map((p) => [p.key, p.default])));
  };

  if (!template) return <></>;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="field">
        <label>Template</label>
        <select value={selected} onChange={(e) => pick(e.target.value)}>
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      <div className="row">
        {template.params.map((p) => (
          <div className="field" key={p.key} style={{ minWidth: 140 }}>
            <label>{p.label}</label>
            <input value={values[p.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))} />
          </div>
        ))}
      </div>
      <button className="btn" onClick={() => onPick(template.build(values))}>Apply template →</button>
    </div>
  );
}

function stripServerFields(rule: Rule): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...rule };
  delete copy['createdAt'];
  delete copy['updatedAt'];
  return copy;
}
