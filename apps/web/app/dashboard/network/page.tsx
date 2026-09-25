import {
  BAN_CATEGORY_META, DISPATCH_MODEL_META, formatDate, formatRelative,
  type BanCategory, type DocumentType, type FraudReport, type IdentityKind, type VehicleCategory,
} from "@rydar/shared";
import { BadgeCheck, Ban, Flag, HandCoins, History, Network, ShieldBan, UserPlus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DOCUMENT_COLUMNS, buildDocumentView, fileKind, type DocumentRow, type DocumentView } from "@/components/drivers/documents";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { ApplicationsCard, type Candidate } from "@/components/network/applications";
import { BannedDriversCard, type BannedDriverRow } from "@/components/network/banned-drivers";
import { JoinLinkCard } from "@/components/network/join-link-card";
import { REPORT_STATUS_FOR_ORG } from "@/components/network/labels";
import { NetworkLive } from "@/components/network/network-live";
import { ReconsiderButton } from "@/components/network/reconsider-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { isAdminRole, requireOrg } from "@/lib/auth";

export const metadata: Metadata = { title: "Réseau" };
export const dynamic = "force-dynamic";

type Ctx = Awaited<ReturnType<typeof requireOrg>>;
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** URL signée d'un fichier du bucket privé driver-documents (null si le stockage ne répond pas). */
async function signedUrl(supabase: Ctx["supabase"], path: string): Promise<string | null> {
  try {
    const res = await Promise.race([
      supabase.storage.from("driver-documents").createSignedUrl(path, 600),
      new Promise<null>((r) => setTimeout(() => r(null), 2500)),
    ]);
    return res && !res.error ? (res.data?.signedUrl ?? null) : null;
  } catch {
    return null;
  }
}

function FleetOnly() {
  const points = [
    ["Lien d'inscription", "Les chauffeurs de vos groupes WhatsApp / Telegram s'inscrivent eux-mêmes et sont rattachés à votre centrale."],
    ["Part chauffeur affichée", "Chaque offre montre ce que gagne le chauffeur : prix = part chauffeur + commission + frais plateforme."],
    ["Commission encaissée", "À la fin de la course, le chauffeur règle la commission depuis l'application ; les mauvais payeurs sont bloqués."],
    ["Bannissement définitif", "Un fraudeur banni ne revient pas, même avec un nouveau compte (téléphone, e-mail, carte VTC, appareil…)."],
  ];
  return (
    <>
      <PageHeader eyebrow="Réseau" title="Réseau de chauffeurs" description="Recrutement par lien, candidatures et bannissements des chauffeurs indépendants." />
      <PageBody>
        <Card className="mx-auto max-w-3xl overflow-hidden">
          <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center">
            <div className="mb-4 grid size-12 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted">
              <Network className="size-5" />
            </div>
            <h2 className="text-[18px] font-semibold tracking-tight">Réservé aux comptes en mode centrale</h2>
            <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-fg-muted">
              Votre compte est en <span className="text-fg">{DISPATCH_MODEL_META.fleet.short}</span> : vos chauffeurs sont gérés depuis la page{" "}
              <Link href="/dashboard/drivers" className="text-brand hover:underline">Chauffeurs</Link>. Le réseau à commission ({DISPATCH_MODEL_META.centrale.short}) est activé par l&apos;équipe Rydar sur demande.
            </p>
          </div>
          <ul className="grid gap-px border-t border-line bg-line sm:grid-cols-2">
            {points.map(([title, text]) => (
              <li key={title} className="bg-ink-800 px-5 py-4">
                <p className="text-[13px] font-medium">{title}</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">{text}</p>
              </li>
            ))}
          </ul>
        </Card>
      </PageBody>
    </>
  );
}

export default async function NetworkPage() {
  const ctx = await requireOrg();
  if (ctx.org.dispatch_model !== "centrale") return <FleetOnly />;
  const tz = ctx.org.timezone;
  const orgId = ctx.org.id;
  const canManage = isAdminRole(ctx.role);
  const db = ctx.supabase;
  const none = Promise.resolve({ data: [] as never[] });

  const [orgRes, pendingRes, bannedRes, activeRes, newRes, settingsRes, identitiesRes, reportsRes, decisionsRes] = await Promise.all([
    db.from("organizations").select("name, join_code, join_enabled, join_auto_approve").eq("id", orgId).maybeSingle(),
    db
      .from("drivers")
      .select("id, number, first_name, last_name, phone, email, vtc_card_number, photo_url, applied_at, application_message, vehicle:vehicles(brand, model, color, plate, category, seats)")
      .eq("organization_id", orgId)
      .eq("application_status", "pending")
      .is("banned_at", null)
      .order("applied_at", { ascending: false }),
    db
      .from("drivers")
      .select("id, number, first_name, last_name, phone, photo_url, banned_at, ban_reason, ban_scope, banned_by_user:users!drivers_banned_by_fkey(full_name, email)")
      .eq("organization_id", orgId)
      .not("banned_at", "is", null)
      .order("banned_at", { ascending: false }),
    db.from("drivers").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status", "active"),
    db.from("drivers").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status", "active").eq("trust_level", "new"),
    db.from("organization_settings").select("new_driver_max_price_cents, trust_after_rides").eq("organization_id", orgId).maybeSingle(),
    // Lisibles par owner / admin uniquement (RLS)
    canManage ? db.from("banned_identities").select("id, kind, hint, driver_id").eq("organization_id", orgId).eq("scope", "org").is("lifted_at", null) : none,
    canManage
      ? db.from("fraud_reports").select("id, driver_id, driver_label, category, reason, status, created_at, reviewed_at").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(30)
      : none,
    db
      .from("drivers")
      .select("id, number, first_name, last_name, application_status, application_reviewed_at, application_note, banned_at")
      .eq("organization_id", orgId)
      .eq("joined_via", "join_link")
      .in("application_status", ["approved", "rejected"])
      .not("application_reviewed_at", "is", null)
      .order("application_reviewed_at", { ascending: false })
      .limit(6),
  ]);

  const org = orgRes.data as { name: string; join_code: string | null; join_enabled: boolean; join_auto_approve: boolean } | null;
  const pending = (pendingRes.data ?? []) as any[];
  const reports = (reportsRes.data ?? []) as Pick<FraudReport, "id" | "driver_id" | "driver_label" | "category" | "reason" | "status" | "created_at" | "reviewed_at">[];
  const identities = (identitiesRes.data ?? []) as { id: string; kind: IdentityKind; hint: string | null; driver_id: string | null }[];

  // Documents déposés par les candidats (application chauffeur), avec aperçu signé
  const ids = pending.map((d) => d.id as string);
  const { data: docRows } = ids.length
    ? await db.from("driver_documents").select(DOCUMENT_COLUMNS).eq("organization_id", orgId).in("driver_id", ids)
    : { data: [] as unknown[] };
  const candidates: Candidate[] = await Promise.all(
    pending.map(async (d) => {
      const view = buildDocumentView(((docRows ?? []) as unknown as DocumentRow[]).filter((x) => x.driver_id === d.id), tz);
      const documents: DocumentView[] = await Promise.all(
        view.items.map(async (doc) => ({ ...doc, kind: fileKind(doc.file_path), url: doc.file_path ? await signedUrl(db, doc.file_path) : null })),
      );
      const vehicle = one(d.vehicle) as Candidate["vehicle"];
      return { ...d, vehicle: vehicle ? { ...vehicle, category: vehicle.category as VehicleCategory } : null, documents, missing: view.missing as DocumentType[] } as Candidate;
    }),
  );

  const lastReport = new Map<string, FraudReport["status"]>();
  for (const r of reports) if (r.driver_id && !lastReport.has(r.driver_id)) lastReport.set(r.driver_id, r.status);
  const banned: BannedDriverRow[] = ((bannedRes.data ?? []) as any[]).map((d) => {
    const by = one(d.banned_by_user) as { full_name: string | null; email: string } | null;
    return {
      ...d,
      banned_by_name: by?.full_name ?? by?.email ?? null,
      identities: identities.filter((i) => i.driver_id === d.id).map(({ id, kind, hint }) => ({ id, kind, hint })),
      report_status: lastReport.get(d.id) ?? null,
    } as BannedDriverRow;
  });
  const decisions = (decisionsRes.data ?? []) as { id: string; number: number; first_name: string; last_name: string; application_status: string; application_reviewed_at: string; application_note: string | null; banned_at: string | null }[];
  const settings = settingsRes.data as { new_driver_max_price_cents: number | null; trust_after_rides: number | null } | null;

  return (
    <>
      <NetworkLive />
      <PageHeader
        eyebrow={DISPATCH_MODEL_META.centrale.label}
        title="Réseau"
        description="Recrutez des chauffeurs indépendants avec votre lien, validez les candidatures et écartez définitivement les fraudeurs."
      />
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Chauffeurs actifs" value={activeRes.count ?? 0} icon={<Users />} />
          <StatCard label="Candidatures" value={candidates.length} sub="en attente de validation" tone={candidates.length ? "amber" : undefined} icon={<UserPlus />} />
          <StatCard label="Nouveaux" value={newRes.count ?? 0} sub="courses plafonnées" icon={<BadgeCheck />} />
          <StatCard label="Bannis" value={banned.length} sub="définitivement" tone={banned.length ? "red" : undefined} icon={<Ban />} />
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <JoinLinkCard
            orgName={org?.name ?? ctx.org.name}
            initial={{ join_code: org?.join_code ?? null, join_enabled: !!org?.join_enabled, join_auto_approve: !!org?.join_auto_approve }}
            canManage={canManage}
          />
          <ApplicationsCard
            candidates={candidates}
            canManage={canManage}
            canReviewDocuments={["owner", "admin", "dispatcher"].includes(ctx.role)}
            newDriverMaxPriceCents={settings?.new_driver_max_price_cents ?? null}
            trustAfterRides={settings?.trust_after_rides ?? null}
            joinActive={!!org?.join_enabled}
          />
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <BannedDriversCard drivers={banned} canManage={canManage} timeZone={tz} />
          <div className="space-y-6">
            {canManage && (
              <Card className="overflow-hidden">
                <CardHeader
                  title="Signalements envoyés à Rydar"
                  icon={<Flag />}
                  description="Envoyés avec un bannissement : Rydar peut bannir le chauffeur de toute la plateforme."
                />
                {!reports.length ? (
                  <p className="px-5 py-5 text-[13px] text-fg-subtle">Aucun signalement. Cochez « Signaler à Rydar » en bannissant un fraudeur.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {reports.map((r) => {
                      const meta = REPORT_STATUS_FOR_ORG[r.status];
                      return (
                        <li key={r.id} className="space-y-1.5 px-5 py-3.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="min-w-0 truncate text-[13.5px] font-medium">
                              {r.driver_id ? <Link href={`/dashboard/drivers/${r.driver_id}`} className="hover:text-brand">{r.driver_label}</Link> : r.driver_label}
                            </p>
                            <Badge tone={meta.tone} pulse={r.status === "open"}>{meta.label}</Badge>
                          </div>
                          <p className="text-[12px] text-fg-subtle">
                            {BAN_CATEGORY_META[r.category as BanCategory]?.label ?? r.category} · envoyé le {formatDate(r.created_at, tz)}
                            {r.reviewed_at ? ` · traité ${formatRelative(r.reviewed_at)}` : ""}
                          </p>
                          <p className="text-[12px] text-fg-muted">{meta.help}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            )}
            <Card className="overflow-hidden">
              <CardHeader title="Dernières décisions" icon={<History />} description="Candidatures validées ou refusées." />
              {!decisions.length ? (
                <p className="px-5 py-5 text-[13px] text-fg-subtle">Aucune décision pour l&apos;instant.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {decisions.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                      <span className="min-w-0">
                        <Link href={`/dashboard/drivers/${d.id}`} className="block truncate text-[13px] font-medium hover:text-brand">
                          {d.first_name} {d.last_name} <span className="num text-[11.5px] font-normal text-fg-subtle">#{d.number}</span>
                        </Link>
                        <span className="block truncate text-[11.5px] text-fg-subtle">
                          {formatRelative(d.application_reviewed_at)}
                          {d.application_status === "rejected" && d.application_note ? ` · ${d.application_note}` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {canManage && d.application_status === "rejected" && !d.banned_at && (
                          <ReconsiderButton driverId={d.id} name={`${d.first_name} ${d.last_name}`} />
                        )}
                        <Badge tone={d.application_status === "approved" ? "green" : "neutral"}>{d.application_status === "approved" ? "Validé" : "Refusé"}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <div className="flex items-start gap-3 rounded-xl border border-line bg-white/[0.015] px-4 py-3.5 text-[12.5px] leading-relaxed text-fg-muted">
              <HandCoins className="mt-0.5 size-4 shrink-0 text-brand" />
              <p>
                Un nouveau chauffeur reçoit d&apos;abord des courses plafonnées, puis passe « Confirmé » après quelques courses réglées. Réglez ces seuils dans{" "}
                <Link href="/dashboard/settings" className="text-brand hover:underline">Réglages</Link>.
              </p>
            </div>
          </div>
        </div>
        {!canManage && (
          <p className="flex items-center gap-2 text-[12px] text-fg-subtle">
            <ShieldBan className="size-3.5" /> Consultation : validations, refus, bannissements et réglages du lien sont réservés aux administrateurs.
          </p>
        )}
      </PageBody>
    </>
  );
}
