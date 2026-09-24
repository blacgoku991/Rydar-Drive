"use client";
import { formatNumber } from "@rydar/shared";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

// Jetons de graphique (thème sombre) — une seule série par graphique :
// la marque lime porte la donnée, le texte reste en encre neutre.
const C = {
  series: "#c8f03c",
  grid: "#1c212b",
  axis: "#5f6777",
  cursor: "#394050",
  surface: "#0e1116",
};

type Point = Record<string, string | number | null>;

function TooltipBox({ active, payload, label, format, labelFormat, name }: any) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value as number;
  return (
    <div className="rounded-lg border border-white/10 bg-ink-700/95 px-3 py-2 shadow-float backdrop-blur">
      <p className="num text-[15px] font-semibold text-fg">{format ? format(v) : formatNumber(v)}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-muted">
        <span className="inline-block h-[2px] w-3 rounded-full" style={{ background: C.series }} />
        {name} · {labelFormat ? labelFormat(label) : label}
      </p>
    </div>
  );
}

export function TrendArea({
  data, x, y, name, format, labelFormat, tickFormat, height = 240,
}: {
  data: Point[]; x: string; y: string; name: string; height?: number;
  format?: (v: number) => string; labelFormat?: (v: any) => string; tickFormat?: (v: any) => string;
}) {
  return (
    <div style={{ height }} role="img" aria-label={`${name} — graphique`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`fill-${y}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.series} stopOpacity={0.16} />
              <stop offset="100%" stopColor={C.series} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={C.grid} strokeWidth={1} />
          <XAxis dataKey={x} tickFormatter={labelFormat} tick={{ fill: C.axis, fontSize: 11 }} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={24} />
          <YAxis tickFormatter={tickFormat} tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
          <Tooltip cursor={{ stroke: C.cursor, strokeWidth: 1 }} content={<TooltipBox format={format} labelFormat={labelFormat} name={name} />} />
          <Area
            type="monotone"
            dataKey={y}
            stroke={C.series}
            strokeWidth={2}
            fill={`url(#fill-${y})`}
            activeDot={{ r: 4.5, fill: C.series, stroke: C.surface, strokeWidth: 2 }}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Columns({
  data, x, y, name, format, labelFormat, height = 220, highlight,
}: {
  data: Point[]; x: string; y: string; name: string; height?: number;
  format?: (v: number) => string; labelFormat?: (v: any) => string; highlight?: (d: Point) => boolean;
}) {
  return (
    <div style={{ height }} role="img" aria-label={`${name} — graphique`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={C.grid} strokeWidth={1} />
          <XAxis dataKey={x} tickFormatter={labelFormat} tick={{ fill: C.axis, fontSize: 11 }} axisLine={{ stroke: C.grid }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
          <YAxis allowDecimals={false} tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
          <Tooltip cursor={{ fill: "rgba(255,255,255,0.03)" }} content={<TooltipBox format={format} labelFormat={labelFormat} name={name} />} />
          <Bar
            dataKey={y}
            maxBarSize={24}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
            fill={C.series}
            activeBar={{ fill: "#dcff5a" }}
            shape={(props: any) => {
              const dim = highlight && !highlight(props.payload);
              const r = Math.min(4, props.width / 2, props.height);
              const { x: bx, y: by, width: w, height: h } = props;
              if (h <= 0) return <g />;
              return (
                <path
                  d={`M${bx},${by + h} L${bx},${by + r} Q${bx},${by} ${bx + r},${by} L${bx + w - r},${by} Q${bx + w},${by} ${bx + w},${by + r} L${bx + w},${by + h} Z`}
                  fill={props.fill}
                  fillOpacity={dim ? 0.35 : 1}
                />
              );
            }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Barres horizontales HTML (catégories nominales : une seule teinte, valeurs lisibles). */
export function BarList({ items, format }: { items: { label: string; value: number }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.label}>
          <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
            <span className="text-fg">{i.label}</span>
            <span className="text-fg-muted">
              <span className="num text-fg">{format ? format(i.value) : formatNumber(i.value)}</span> · {Math.round((i.value / total) * 100)} %
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.05]">
            <div className="h-full rounded-full bg-brand" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Vue tableau (accessibilité : aucune valeur n'est réservée au survol). */
export function DataTable({ rows, columns }: { rows: Point[]; columns: { key: string; label: string; format?: (v: any) => string }[] }) {
  return (
    <details className="group mt-3">
      <summary className="cursor-pointer list-none text-[12px] text-fg-subtle hover:text-fg-muted">
        <span className="group-open:hidden">Voir les données</span>
        <span className="hidden group-open:inline">Masquer les données</span>
      </summary>
      <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-line">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-ink-700">
            <tr>{columns.map((c) => <th key={c.key} className="px-3 py-1.5 text-left font-medium text-fg-subtle">{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line/60">
                {columns.map((c) => <td key={c.key} className="num px-3 py-1.5 text-fg-muted">{c.format ? c.format(r[c.key]) : String(r[c.key] ?? "—")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
