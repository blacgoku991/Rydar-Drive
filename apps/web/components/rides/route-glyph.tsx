import { decodePolyline, type Coord } from "@rydar/shared";

/**
 * Miniature SVG du tracé réel d'une course (sans tuiles ni requête) :
 * point de départ vert, arrivée carrée. Repli : segment droit.
 */
export function RouteGlyph({
  polyline,
  from,
  to,
  width = 64,
  height = 40,
}: {
  polyline?: string | null;
  from?: { lat: number; lng: number } | null;
  to?: { lat: number | null; lng: number | null } | null;
  width?: number;
  height?: number;
}) {
  let pts: Coord[] = polyline ? decodePolyline(polyline) : [];
  if (pts.length < 2 && from && to?.lat != null && to?.lng != null) pts = [[from.lng, from.lat], [to.lng, to.lat]];
  if (pts.length < 2) return <span className="block rounded-md bg-white/[0.03]" style={{ width, height }} />;
  const k = Math.cos((pts[0]![1] * Math.PI) / 180);
  const xs = pts.map((p) => p[0] * k);
  const ys = pts.map((p) => -p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 6;
  const scale = Math.min((width - pad * 2) / (maxX - minX || 1e-9), (height - pad * 2) / (maxY - minY || 1e-9));
  const ox = (width - (maxX - minX) * scale) / 2;
  const oy = (height - (maxY - minY) * scale) / 2;
  const P = xs.map((x, i) => [ox + (x - minX) * scale, oy + (ys[i]! - minY) * scale] as const);
  const d = P.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const [sx, sy] = P[0]!;
  const [ex, ey] = P[P.length - 1]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0 rounded-md bg-white/[0.03]" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="text-fg-muted" strokeDasharray={polyline ? undefined : "2 3"} />
      <circle cx={sx} cy={sy} r={2.6} className="fill-brand" />
      <rect x={ex - 2.3} y={ey - 2.3} width={4.6} height={4.6} rx={1} className="fill-fg" />
    </svg>
  );
}
