import { createContext, useContext, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Me { id: string; email: string; name: string; role: 'admin' | 'manager'; mustChangePassword: boolean }
export const AuthContext = createContext<{ me: Me; isAdmin: boolean }>(null as any);
export const useAuth = () => useContext(AuthContext);

export type RangeKey = '1' | '7' | '30' | '90' | '365';
export const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: '1', label: 'Last 24 hours' }, { key: '7', label: 'Last 7 days' }, { key: '30', label: 'Last 30 days' }, { key: '90', label: 'Last 90 days' }, { key: '365', label: 'Last 12 months' },
];
export function useRange(initial: RangeKey = '7') {
  return useState<RangeKey>(initial);
}

export function useApi<T = any>(key: unknown[], path: string, opts: { enabled?: boolean; refetchMs?: number } = {}) {
  return useQuery<T>({ queryKey: key, queryFn: () => api<T>(path), enabled: opts.enabled ?? true, refetchInterval: opts.refetchMs });
}

export function Provide({ children, value }: { children: ReactNode; value: { me: Me; isAdmin: boolean } }) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
