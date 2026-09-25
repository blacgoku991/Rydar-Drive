// Sonde de santé (Docker, supervision) : le serveur répond, sans dépendance externe.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, service: "rydar-web" }, { headers: { "Cache-Control": "no-store" } });
}
