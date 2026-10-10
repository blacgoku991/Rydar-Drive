import { formatRelative, formatTime, type WebhookEndpoint } from "@rydar/shared";
import { Activity, BookOpen, Code2, Globe, KeyRound, Lock, Webhook } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ApiKeysPanel, type ApiKeyRow } from "@/components/dashboard-integrations";
import { WebhooksPanel, type WebhookDeliveryRow } from "@/components/dashboard-webhooks";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { siteLink } from "@/components/private-fleet/site-status";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Disclosure } from "@/components/ui/disclosure";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { privateFleetPage } from "@/lib/private-fleet";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { WEBHOOK_ENDPOINT_SELECT } from "@/lib/webhooks";

export const metadata: Metadata = { title: "API & site web" };
export const dynamic = "force-dynamic";

const NB = " ";

const DELIVERY_SELECT =
  "id, endpoint_id, ride_id, event_type, occurred_at, status, attempts, next_attempt_at, last_status_code, last_error, delivered_at, created_at";

/**
 * Par adresse : ses 10 derniers envois, plus ses 10 derniers envois en ÉCHEC (« Renvoyer »), même plus anciens. Les
 * envois qui attendent un nouvel essai restent « pending » jusqu'au dernier : les mêler aux échecs les cacherait
 * derrière eux pendant une longue panne du destinataire, juste quand il faut les renvoyer.
 */
const RECENT_PER_ENDPOINT = 10;
const FAILED_PER_ENDPOINT = 10;

type OrgCtx = Awaited<ReturnType<typeof requireOrg>>;

/**
 * Webhooks et envois récents de CHAQUE adresse, lus par RLS (owner / admin) ; numéro de course ajouté pour
 * l'affichage. Une limite commune à la centrale cachait les échecs d'une adresse (et son bouton « Renvoyer ») derrière
 * les succès des autres : chaque adresse a donc ses envois, et celle qui a déjà échoué garde aussi ses derniers échecs.
 */
async function loadWebhooks(ctx: OrgCtx): Promise<{ endpoints: WebhookEndpoint[]; deliveries: WebhookDeliveryRow[] }> {
  const res = await ctx.supabase
    .from("webhook_endpoints")
    .select(WEBHOOK_ENDPOINT_SELECT)
    .eq("organization_id", ctx.org.id)
    .order("created_at", { ascending: true });
  if (res.error) console.error("[integrations] webhooks illisibles", res.error.message);
  const endpoints = (res.data ?? []) as unknown as WebhookEndpoint[];
  const query = (endpointId: string) =>
    ctx.supabase.from("webhook_deliveries").select(DELIVERY_SELECT).eq("organization_id", ctx.org.id).eq("endpoint_id", endpointId);
  const lists = await Promise.all(
    endpoints.flatMap((e) => [
      query(e.id).order("created_at", { ascending: false }).limit(RECENT_PER_ENDPOINT),
      // Échecs définitifs seulement (jamais « pending ») : pour une adresse qui a déjà échoué (aucun parcours inutile sinon)
      ...(e.last_failure_at
        ? [query(e.id).eq("status", "failed").order("created_at", { ascending: false }).limit(FAILED_PER_ENDPOINT)]
        : []),
    ]),
  );
  const failed = lists.find((l) => l.error);
  if (failed?.error) console.error("[integrations] envois de webhooks illisibles", failed.error.message);
  const byId = new Map<string, Omit<WebhookDeliveryRow, "ride_number">>();
  for (const l of lists) for (const d of (l.data ?? []) as unknown as Omit<WebhookDeliveryRow, "ride_number">[]) byId.set(d.id, d);
  const rows = [...byId.values()];
  const rideIds = [...new Set(rows.map((d) => d.ride_id).filter((id): id is string => !!id))];
  const { data: rides } = rideIds.length
    ? await ctx.supabase.from("rides").select("id, number").eq("organization_id", ctx.org.id).in("id", rideIds)
    : { data: [] as { id: string; number: number }[] };
  const numbers = new Map((rides ?? []).map((r: { id: string; number: number }) => [r.id, r.number]));
  return {
    endpoints,
    deliveries: rows.map((d) => ({ ...d, ride_number: d.ride_id ? (numbers.get(d.ride_id) ?? null) : null })),
  };
}

const METHOD_TONE: Record<string, string> = { POST: "bg-brand/12 text-brand", DELETE: "bg-red/12 text-red", GET: "bg-blue/12 text-blue" };

/**
 * API & site web (docs/REFONTE-PANELS.md § 5.6, lot R10) : l'état du site d'abord (siteLink, même règle que « Mon site »
 * de la Flotte Privée), puis les clés de connexion et les webhooks (propriétaire et administrateurs), et la
 * documentation technique repliée (points d'entrée, exemples, journal des requêtes). Lectures et actions inchangées.
 */
export default async function IntegrationsPage() {
  const ctx = await requireOrg();
  // Flotte Privée : clés et webhooks gérés par l'équipe Rydar (D16) → « Mon site », en lecture seule
  privateFleetPage(ctx, { redirect: "/dashboard/site" });
  const admin = isAdminRole(ctx.role);
  const [{ data: keys }, { data: logs }, { data: usage }, webhooks] = await Promise.all([
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
    admin ? loadWebhooks(ctx) : Promise.resolve({ endpoints: [], deliveries: [] }),
  ]);
  const apiEnabled = Boolean((usage as any)?.limits?.api_access);
  // Heure du rendu : temps relatifs identiques au serveur et à l'hydratation
  const serverNow = Date.now();
  const base = `${env.appUrl}/api/v1`;
  const keyRows = (keys ?? []) as ApiKeyRow[];
  const link = admin ? siteLink(keyRows, webhooks.endpoints, serverNow) : null;

  const curl = `curl -X POST ${base}/rides \\
  -H "Authorization: Bearer rdk_live_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: 5f0c8a2e-3b7d-4e61-9a4c-2d8e7b1f6c30" \\
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

  const webhook = `// Réception d'un webhook Rydar Drive (route Next.js) : signature vérifiée sur le corps BRUT
import { createHmac, timingSafeEqual } from "node:crypto";

export async function POST(req) {
  const raw = await req.text();
  const ts = req.headers.get("x-rydar-timestamp") ?? "";
  const sig = req.headers.get("x-rydar-signature") ?? "";
  const expected = "v1=" + createHmac("sha256", process.env.RYDAR_WEBHOOK_SECRET).update(\`\${ts}.\${raw}\`).digest("hex");
  const fresh = /^\\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) <= 300; // 5 minutes
  // Format contrôlé AVANT timingSafeEqual (exception si les longueurs en octets diffèrent : en-tête forgé)
  const valid = /^v1=[0-9a-f]{64}$/.test(sig) && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!fresh || !valid) return new Response("Signature invalide", { status: 401 });
  const event = JSON.parse(raw); // { id, type: "ride.completed", created_at, data: { ride, status, previous_status } }
  // Dédoublonnez sur event.id ; ne faites jamais reculer une course (data.ride.updated_at)
  return new Response(null, { status: 204 }); // répondre vite (2xx en moins de 10 s)
}`;

  const response = `HTTP/1.1 201 Created
{
  "data": {
    "id": "5f0c…", "number": 1928, "type": "scheduled", "status": "OFFERED",
    "pickup_at": "2026-09-25T04:30:00Z", "price_cents": 7900,
    "tracking": { "status_url": "${base}/rides/5f0c…" }
  }
}`;

  const endpointsList: [string, string, string][] = [
    ["POST", "/rides", "Créer une course (recherche immédiate ou planifiée)"],
    ["GET", "/rides/{id}", "Statut, chauffeur attribué, horodatages"],
    ["GET", "/rides?external_reference=…", "Retrouver une réservation"],
    ["POST", "/rides/{id}/cancel", "Annuler (avant prise en charge)"],
    ["GET", "/ping", "Vérifier la clé"],
    ["POST", "/webhooks", "Enregistrer l'adresse qui reçoit les événements (permission « Webhooks »)"],
    ["DELETE", "/webhooks/{id}", "Supprimer une adresse de webhook"],
  ];

  return (
    <>
      <PageHeader
        title="API & site web"
        description={`Reliez le formulaire de réservation de votre site${NB}: chaque réservation crée la course et lance la recherche d'un chauffeur.`}
      />
      <PageBody className="space-y-6">
        {!apiEnabled && (
          <Callout
            tone="warning"
            title="Non compris dans votre offre."
            action={
              admin ? (
                <Link
                  href="/dashboard/settings?tab=billing"
                  prefetch={false}
                  className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-2 hover:text-brand sm:min-h-0"
                >
                  Voir les offres
                </Link>
              ) : undefined
            }
          >
            L&apos;API de réservation n&apos;est pas incluse dans votre offre actuelle{NB}: votre site ne peut pas encore envoyer de réservations.
          </Callout>
        )}

        {link ? (
          <Card>
            <CardBody className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03]">
                <Globe className={cn("size-5", link.linked ? "text-brand" : "text-fg-subtle")} />
              </span>
              <div className="min-w-0 flex-1 basis-[14rem]">
                <h2 className="text-[15px] font-semibold text-fg [overflow-wrap:anywhere]">
                  {link.linked ? `Votre site est relié${link.host ? ` (${link.host})` : ""}` : "Aucun site relié pour l'instant"}
                </h2>
                <p className="mt-0.5 text-[13px] text-fg-muted">
                  {link.linked
                    ? link.lastUsedAt
                      ? `Dernière utilisation ${formatRelative(link.lastUsedAt, new Date(serverNow))} · ${link.activeKeys.length} clé${link.activeKeys.length > 1 ? "s" : ""} active${link.activeKeys.length > 1 ? "s" : ""}`
                      : "Clé active, pas encore utilisée par votre site."
                    : "Créez une clé ci-dessous et donnez-la à la personne qui gère votre site."}
                </p>
              </div>
              <Badge tone={link.linked ? "green" : "neutral"}>{link.linked ? "Relié" : "Non relié"}</Badge>
            </CardBody>
          </Card>
        ) : (
          <Callout tone="neutral" role={null} icon={<Lock />}>
            Les clés de connexion et les webhooks sont gérés par le propriétaire ou un administrateur.
          </Callout>
        )}

        {admin && (
          <Card>
            <CardHeader
              title="Clés de connexion"
              icon={<KeyRound />}
              description="Une clé relie votre site à votre compte. Donnez-la seulement à la personne qui gère votre site."
            />
            <CardBody>
              <ApiKeysPanel keys={keyRows} canManage={apiEnabled} serverNow={serverNow} />
            </CardBody>
          </Card>
        )}

        {admin && (
          <Card>
            <CardHeader title="Notifications envoyées à votre site (webhooks)" icon={<Webhook />} />
            <CardBody>
              <WebhooksPanel
                endpoints={webhooks.endpoints}
                deliveries={webhooks.deliveries}
                canManage={apiEnabled}
                timezone={ctx.org.timezone}
                serverNow={serverNow}
              />
            </CardBody>
          </Card>
        )}

        <Disclosure
          title="Documentation pour votre développeur"
          hint={<span className="hidden text-[12.5px] font-normal text-fg-muted sm:inline">Points d&apos;entrée, exemples, journal des requêtes</span>}
          className="surface rounded-xl px-5"
          summaryClassName="py-2"
          contentClassName="space-y-6 border-t border-line pb-5 pt-5"
        >
          <section aria-labelledby="doc-points" className="space-y-3">
            <h3 id="doc-points" className="flex items-center gap-2 text-[14px] font-semibold text-fg">
              <BookOpen aria-hidden className="size-4 text-fg-muted" /> Points d&apos;entrée
            </h3>
            <p className="mono text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">{base}</p>
            <ul className="space-y-2.5 text-[13px]">
              {endpointsList.map(([m, p, d]) => (
                <li key={`${m} ${p}`} className="flex items-start gap-3">
                  <span className={cn("num w-16 shrink-0 rounded-md px-1.5 py-0.5 text-center text-[12px] font-semibold", METHOD_TONE[m])}>{m}</span>
                  <div className="min-w-0">
                    <p className="num text-fg [overflow-wrap:anywhere]">{p}</p>
                    <p className="text-[12.5px] text-fg-muted">{d}</p>
                  </div>
                </li>
              ))}
            </ul>
            <ul className="space-y-1.5 border-t border-line pt-3 text-[12.5px] text-fg-muted">
              <li>
                Authentification{NB}: <span className="num text-fg">Authorization: Bearer &lt;clé&gt;</span>
              </li>
              <li>
                <span className="num text-fg">organization_id</span> est interdit dans le corps{NB}: la clé désigne votre compte (403 sinon).
              </li>
              <li>
                Idempotence{NB}: en-tête <span className="num text-fg">Idempotency-Key</span> (un UUID par réservation, unique et imprévisible{NB}: pas de
                doublon en cas de nouvel essai).
              </li>
              <li>
                Limite par clé (429 + <span className="num text-fg">Retry-After</span>), journal de chaque requête.
              </li>
            </ul>
          </section>

          <section aria-labelledby="doc-exemples" className="space-y-3">
            <h3 id="doc-exemples" className="flex items-center gap-2 text-[14px] font-semibold text-fg">
              <Code2 aria-hidden className="size-4 text-fg-muted" /> Exemples d&apos;intégration
            </h3>
            <p className="text-[12.5px] text-fg-muted">Appelez l&apos;API depuis votre serveur{NB}: la clé ne doit jamais apparaître dans le navigateur.</p>
            <Tabs defaultValue="curl">
              <TabsList className="flex h-auto max-w-full flex-wrap">
                <TabsTrigger value="curl" className="h-9">
                  cURL
                </TabsTrigger>
                <TabsTrigger value="php" className="h-9">
                  PHP / WordPress
                </TabsTrigger>
                <TabsTrigger value="node" className="h-9">
                  Node.js
                </TabsTrigger>
                <TabsTrigger value="response" className="h-9">
                  Réponse
                </TabsTrigger>
                <TabsTrigger value="webhook" className="h-9">
                  Webhook
                </TabsTrigger>
              </TabsList>
              <TabsContent value="curl" className="mt-4">
                <CodeBlock code={curl} language="bash" />
              </TabsContent>
              <TabsContent value="php" className="mt-4">
                <CodeBlock code={php} language="php" />
              </TabsContent>
              <TabsContent value="node" className="mt-4">
                <CodeBlock code={node} language="javascript" />
              </TabsContent>
              <TabsContent value="response" className="mt-4">
                <CodeBlock code={response} language="http" />
              </TabsContent>
              <TabsContent value="webhook" className="mt-4">
                <CodeBlock code={webhook} language="javascript" />
              </TabsContent>
            </Tabs>
          </section>

          {admin && (
            <section aria-labelledby="doc-journal" className="space-y-2">
              <h3 id="doc-journal" className="flex items-center gap-2 text-[14px] font-semibold text-fg">
                <Activity aria-hidden className="size-4 text-fg-muted" /> Journal des requêtes
              </h3>
              <p className="text-[12.5px] text-fg-muted">40 dernières requêtes reçues par l&apos;API (conservées 90 jours).</p>
              {!logs?.length ? (
                <p className="py-2 text-[13px] text-fg-muted">Aucune requête pour le moment.</p>
              ) : (
                <ul className="divide-y divide-line/70 rounded-xl border border-line px-4">
                  {(logs ?? []).map((l: any) => (
                    <li key={l.id} className="num flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
                      <span className="order-1 w-[4.5rem] shrink-0 text-fg-muted">{formatTime(l.created_at, ctx.org.timezone, true)}</span>
                      <span className="order-2 w-14 shrink-0 font-semibold text-fg-muted">{l.method}</span>
                      <span className="order-5 min-w-0 basis-full truncate text-fg sm:order-3 sm:basis-0 sm:flex-1" title={l.path}>
                        {l.path}
                        {l.error_code ? <span className="ml-2 text-fg-muted">{l.error_code}</span> : null}
                      </span>
                      <Badge tone={l.status_code < 300 ? "green" : l.status_code < 500 ? "amber" : "red"} dot={false} className="order-3 justify-center sm:order-4">
                        {l.status_code}
                      </Badge>
                      <span className="order-4 text-right text-fg-muted sm:order-5 sm:w-16">{l.latency_ms ?? "—"}{NB}ms</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </Disclosure>
      </PageBody>
    </>
  );
}
