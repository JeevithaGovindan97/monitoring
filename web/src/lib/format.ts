import { createContext, useContext } from 'react';

export const TzContext = createContext<string>('UTC');
export const useTz = () => useContext(TzContext);

export function fmtDateTime(v: string | Date | null | undefined, tz = 'UTC'): string {
  if (!v) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v));
  } catch {
    return new Date(v).toISOString();
  }
}
export function fmtDate(v: string | Date | null | undefined, tz = 'UTC'): string {
  if (!v) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(v));
  } catch {
    return String(v).slice(0, 10);
  }
}
export function fmtShort(v: string | Date, tz = 'UTC', withTime = true): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(v));
}
export function ago(v: string | Date | null | undefined): string {
  if (!v) return 'never';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 0) return 'in the future';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function dur(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}
export const num = (v: number | null | undefined, empty = '—') => (v === null || v === undefined ? empty : Number(v).toLocaleString('en-GB'));
export const pct = (v: number | null | undefined, digits = 2, empty = 'No data') => (v === null || v === undefined ? empty : `${Number(v).toFixed(digits)}%`);
export const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v).toLocaleString('en-GB')} ms`);
export const title = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');

/** Percentage change between two totals, or null when it cannot be computed honestly. */
export function delta(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}
