import { useState } from 'react';
import { ToastProvider } from './toast.tsx';
import { Dashboard } from './views/Dashboard.tsx';
import { Rules } from './views/Rules.tsx';
import { Logs } from './views/Logs.tsx';
import { Descriptors } from './views/Descriptors.tsx';
import { Settings } from './views/Settings.tsx';

type View = 'dashboard' | 'rules' | 'logs' | 'descriptors' | 'settings';

const NAV: Array<{ id: View; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'rules', label: 'Rules' },
  { id: 'logs', label: 'Logs' },
  { id: 'descriptors', label: 'gRPC Descriptors' },
  { id: 'settings', label: 'Settings' },
];

export function App(): JSX.Element {
  const [view, setView] = useState<View>('dashboard');
  return (
    <ToastProvider>
      <div className="app">
        <aside className="sidebar">
          <h1>morpheus</h1>
          <div className="rev">proxy control plane</div>
          <nav className="nav">
            {NAV.map((n) => (
              <button
                key={n.id}
                className={view === n.id ? 'active' : ''}
                onClick={() => setView(n.id)}
              >
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
        </aside>
        <main className="main">
          {view === 'dashboard' && <Dashboard onNavigate={setView} />}
          {view === 'rules' && <Rules />}
          {view === 'logs' && <Logs />}
          {view === 'descriptors' && <Descriptors />}
          {view === 'settings' && <Settings />}
        </main>
      </div>
    </ToastProvider>
  );
}
