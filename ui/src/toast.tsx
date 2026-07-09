import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  kind: 'ok' | 'err';
  message: string;
}

const ToastContext = createContext<(kind: 'ok' | 'err', message: string) => void>(() => {});

export function useToast(): (kind: 'ok' | 'err', message: string) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: 'ok' | 'err', message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}>
          {t.message}
        </div>
      ))}
    </ToastContext.Provider>
  );
}
