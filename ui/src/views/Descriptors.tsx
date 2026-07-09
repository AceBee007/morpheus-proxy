import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useToast } from '../toast.tsx';

interface DescriptorInfo {
  id: string;
  name: string;
  format: string;
  services: Array<{ fullName: string; methods: Array<{ name: string; requestStream: boolean; responseStream: boolean }> }>;
}

export function Descriptors(): JSX.Element {
  const toast = useToast();
  const [items, setItems] = useState<DescriptorInfo[]>([]);
  const [name, setName] = useState('demo.proto');
  const [source, setSource] = useState(
    'syntax = "proto3";\npackage demo;\nservice TimeService {\n  rpc Now (NowRequest) returns (NowResponse);\n}\nmessage NowRequest { string tz = 1; }\nmessage NowResponse { string iso = 1; }\n',
  );

  const reload = useCallback(async () => {
    try {
      const data = await api.listDescriptors();
      setItems(data.items as unknown as DescriptorInfo[]);
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async (): Promise<void> => {
    try {
      await api.addDescriptor({ name, format: 'proto_source', content: source });
      toast('ok', `Descriptor "${name}" registered`);
      await reload();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api.deleteDescriptor(id);
      await reload();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <h2>gRPC Descriptors</h2>
      <p className="muted">
        gRPC body decode, matching, mock generation and manipulation require a registered
        descriptor. Without one, only metadata / path / grpc-status are available.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Register .proto source</h3>
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 260 }} />
        </div>
        <div className="field">
          <label>.proto source</label>
          <textarea rows={10} value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} />
        </div>
        <button className="btn" onClick={add}>Register</button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Registered</h3>
        {items.length === 0 && <div className="muted">No descriptors registered.</div>}
        {items.map((d) => (
          <div key={d.id} style={{ borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
            <div className="row">
              <strong>{d.name}</strong>
              <span className="tag">{d.format}</span>
              <span className="muted mono" style={{ fontSize: 11 }}>{d.id}</span>
              <div className="spacer" />
              <button className="btn danger" onClick={() => void remove(d.id)}>Delete</button>
            </div>
            {d.services.map((svc) => (
              <div key={svc.fullName} style={{ marginTop: 6 }}>
                <div className="mono" style={{ fontSize: 12 }}>{svc.fullName}</div>
                <div className="pill-row" style={{ marginTop: 4 }}>
                  {svc.methods.map((m) => (
                    <span key={m.name} className="tag">
                      {m.name}
                      {(m.requestStream || m.responseStream) && ' (stream)'}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
