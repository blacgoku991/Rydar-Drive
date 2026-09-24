import { formatTime } from "@rydar/shared";
import { Activity, BookOpen, Code2, KeyRound } from "lucide-react";
import type { Metadata } from "next";
import { ApiKeysPanel, type ApiKeyRow } from "@/components/dashboard-integrations";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "API & site web" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const ctx = await requireOrg();
  const admin = isAdminRole(ctx.role);
  const [{ data: keys }, { data: logs }, { data: usage }] = await Promise.all([
    admin
      ? ctx.supabase
          .from("api_keys")
          .select("id, name, prefix, last4, scopes, rate_limit_per_minute, allowed_origins, created_at, last_used_at, expires_at, revoked_at")
          .eq("organization_id", ctx.org.id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    admin
      ? ctx.supabase.from("api_logs").select("id, method, path, status_code, latency_ms, ip, error_code, created_at").eq("organization_id", ctx.org.id).order("id", { ascending: false }).limit(40)
      : Promise.resolve({ data: [] }),
    ctx.supabase.rpc("org_usage", { p_org: ctx.org.id }),
  ]);
  const apiEnabled = Boolean((usage as any)?.limits?.api_access);
  const base = `${env.appUrl}/api/v1`;

  const curl = `curl -X POST ${base}/rides \\
  -H "Authorization: Bearer rdk_live_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: resa-2026-0925-0630-dubois" \\
  -d '{
    "pickup":  { "address": "72 Avenue Foch, 75116 Paris", "lat": 48.8718, "lng": 2.2830 },
    "dropoff": { "address": "Aéroport CDG, Terminal 2E" },
    "pickup_at": "2026-09-25T06:30:00+02:00",
    "customer": { "name": "M. Laurent Dubois", "phone": "+33612345678" },
    "passengers": 2, "luggage": 2,
    "vehicle_category": "business",
    "price_cents": 7900,
    "payment_method": "card",
    "flight_number": "AF1680",
    "comment": "Pancarte au nom du client"
  }'`;

  const php = `<?php // Formulaire de réservation (WordPress, site PHP…) → Rydar Drive
$payload = [
  'pickup'   => ['address' => $_POST['depart']],      // lat/lng facultatifs : géocodage automatique
  'dropoff'  => ['address' => $_POST['destination']],
  'date'     => $_POST['date'],                       // "2026-09-25"
  'time'     => $_POST['heure'],                      // "06:30" (fuseau de l'organisation)
  'customer' => ['name' => $_POST['nom'], 'phone' => $_POST['telephone']],
  'passengers' => (int) $_POST['passagers'],
  'vehicle_category' => 'business',
];
$ch = curl_init('${base}/rides');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('RYDAR_API_KEY'), 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode($payload),
]);
$response = json_decode(curl_exec($ch), true); // ['data' => ['id' => …, 'number' => 1928, 'status' => 'OFFERED']]`;

  const node = `const res = await fetch("${base}/rides", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.RYDAR_API_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({
    pickup: { address: "Gare de Lyon, Paris", lat: 48.8443, lng: 2.3743 },
    dropoff: { address: "Disneyland Paris" },
    customer: { name: "Famille Martin", phone: "0612345678" },
    passengers: 6, vehicle_category: "van",
  }),
});
const { data } = await res.json(); // data.status : "SEARCHING_DRIVER" | "OFFERED" | …`;

  const response = `HTTP/1.1 201 Created
{
  "data": {
    "id": "5f0c…", "number": 1928, "type": "scheduled", "status": "OFFERED",
    "pickup_at": "2026-09-25T04:30:00Z", "price_cents": 7900,
    "tracking": { "status_url": "${base}/rides/5f0c…" }
  }
}`;

  return (
    <>
      <PageHeader
        eyebrow="Canaux"
        title="API & site web"
        description="Connectez le formulaire de réservation de votre site : chaque réservation crée la course et lance le dispatch automatiquement."
      />
      <PageBody className="space-y-6">
        {!apiEnabled && (
          <div className="rounded-xl border border-amber/30 bg-amber/[0.06] px-4 py-3 text-[13px] text-amber">
            L&apos;API n&apos;est pas incluse dans votre offre actuelle. Passez à l&apos;offre Pro pour connecter votre site.
          </div>
        )}
        <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
          <Card>
            <CardHeader title="Clés API" icon={<KeyRound />} description="Hashées (HMAC-SHA256) : jamais stockées en clair. Rotation sans interruption." />
            <CardBody>
              {admin ? <ApiKeysPanel keys={(keys ?? []) as ApiKeyRow[]} canManage={apiEnabled} /> : <p className="text-[13px] text-fg-subtle">Réservé aux administrateurs.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Points d'entrée" icon={<BookOpen />} description={base} />
            <CardBody className="space-y-2.5 text-[13px]">
              {[
                ["POST", "/rides", "Créer une course (dispatch immédiat ou planifié)"],
                ["GET", "/rides/{id}", "Statut, chauffeur attribué, horodatages"],
                ["GET", "/rides?external_reference=…", "Retrouver une réservation"],
                ["POST", "/rides/{id}/cancel", "Annuler (avant prise en charge)"],
                ["GET", "/ping", "Vérifier la clé"],
              ].map(([m, p, d]) => (
                <div key={p} className="flex items-start gap-3">
                  <span className={`num w-12 shrink-0 rounded-md px-1.5 py-0.5 text-center text-[10.5px] font-semibold ${m === "POST" ? "bg-brand/12 text-brand" : "bg-blue/12 text-blue"}`}>{m}</span>
                  <div>
                    <p className="num text-fg">{p}</p>
                    <p className="text-[12px] text-fg-subtle">{d}</p>
                  </div>
                </div>
              ))}
              <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-[12px] text-fg-muted">
                <p>• Authentification : <span className="num text-fg">Authorization: Bearer &lt;clé&gt;</span></p>
                <p>• <span className="num text-fg">organization_id</span> est interdit dans le corps : la clé détermine le tenant (403 sinon).</p>
                <p>• Idempotence : en-tête <span className="num text-fg">Idempotency-Key</span> (pas de doublon en cas de ré-essai).</p>
                <p>• Limite par clé (429 + <span className="num text-fg">Retry-After</span>), journal de chaque requête.</p>
              </div>
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader title="Exemples d'intégration" icon={<Code2 />} description="Appelez l'API depuis votre serveur : la clé ne doit jamais apparaître dans le navigateur." />
          <CardBody>
            <Tabs defaultValue="curl">
              <TabsList>
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP / WordPress</TabsTrigger>
                <TabsTrigger value="node">Node.js</TabsTrigger>
                <TabsTrigger value="response">Réponse</TabsTrigger>
              </TabsList>
              <TabsContent value="curl" className="mt-4"><CodeBlock code={curl} language="bash" /></TabsContent>
              <TabsContent value="php" className="mt-4"><CodeBlock code={php} language="php" /></TabsContent>
              <TabsContent value="node" className="mt-4"><CodeBlock code={node} language="javascript" /></TabsContent>
              <TabsContent value="response" className="mt-4"><CodeBlock code={response} language="http" /></TabsContent>
            </Tabs>
          </CardBody>
        </Card>

        {admin && (
          <Card className="overflow-hidden">
            <CardHeader title="Journal des requêtes" icon={<Activity />} description="40 dernières requêtes API (conservées 90 jours)." />
            <div className="divide-y divide-line/70">
              {!logs?.length && <p className="px-5 py-6 text-[13px] text-fg-subtle">Aucune requête pour le moment.</p>}
              {(logs ?? []).map((l: any) => (
                <div key={l.id} className="num grid grid-cols-[80px_56px_1fr_60px_70px] items-center gap-3 px-5 py-2 text-[12.5px]">
                  <span className="text-fg-subtle">{formatTime(l.created_at, ctx.org.timezone, true)}</span>
                  <span className="font-semibold text-fg-muted">{l.method}</span>
                  <span className="truncate text-fg">{l.path}{l.error_code ? <span className="ml-2 text-fg-subtle">{l.error_code}</span> : null}</span>
                  <Badge tone={l.status_code < 300 ? "green" : l.status_code < 500 ? "amber" : "red"} dot={false} className="justify-center">{l.status_code}</Badge>
                  <span className="text-right text-fg-subtle">{l.latency_ms ?? "—"} ms</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </PageBody>
    </>
  );
}
