import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart, ComposedChart, Area } from 'recharts';
import { fmtShort } from './format';
import { Empty } from '../components/ui';

export const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];

export interface Series { key: string; label: string; color?: string; yAxisId?: 'left' | 'right'; type?: 'line' | 'bar' | 'area'; dashed?: boolean }

/** Time-series chart over stored data. Renders an explicit empty state – never a flat fake line. */
export function TimeChart({ data, series, tz, height = 260, xKey = 'x', withTime = true, unit, rightUnit, emptyText = 'No data for this period.', gaps = true }: {
  data: Array<Record<string, any>>; series: Series[]; tz: string; height?: number; xKey?: string; withTime?: boolean; unit?: string; rightUnit?: string; emptyText?: string; gaps?: boolean;
}) {
  if (!data.length) return <Empty title="No data yet">{emptyText}</Empty>;
  const hasRight = series.some((s) => s.yAxisId === 'right');
  const tickFmt = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtShort(v + 'T00:00:00Z', 'UTC', false) : fmtShort(v, tz, withTime));
  return (
    <div role="img" aria-label={`Chart: ${series.map((s) => s.label).join(', ')}`} style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} tickFormatter={tickFmt} minTickGap={36} tickMargin={6} />
          <YAxis yAxisId="left" width={52} unit={unit} />
          {hasRight && <YAxis yAxisId="right" orientation="right" width={52} unit={rightUnit} />}
          <Tooltip labelFormatter={(v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fmtShort(v as string, tz, true))} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }} />
          <Legend />
          {series.map((s, i) => {
            const color = s.color ?? COLORS[i % COLORS.length]!;
            const common = { key: s.key, dataKey: s.key, name: s.label, yAxisId: s.yAxisId ?? 'left', stroke: color, isAnimationActive: false } as const;
            if (s.type === 'bar') return <Bar {...common} fill={color} />;
            if (s.type === 'area') return <Area {...common} fill={color} fillOpacity={0.12} connectNulls={!gaps} />;
            return <Line {...common} dot={false} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} connectNulls={!gaps} />;
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
export { LineChart, BarChart };
