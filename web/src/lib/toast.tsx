import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Toasts } from '../components/ui';

type Fn = (kind: 'ok' | 'err', text: string) => void;
const Ctx = createContext<Fn>(() => undefined);
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Array<{ id: number; kind: 'ok' | 'err'; text: string }>>([]);
  const push = useCallback<Fn>((kind, text) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'err' ? 7000 : 3500);
  }, []);
  return <Ctx.Provider value={push}>{children}<Toasts items={items} /></Ctx.Provider>;
}
