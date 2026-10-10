import { formatDate, formatNumber, legalAcceptanceState, legalDateLabel, localIsoDay, noticeMinDay, type LegalAcceptanceState } from "@rydar/shared";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalInfoForm } from "@/components/admin/legal-form";
import { OrgTermsNotifyButton } from "@/components/admin/org-terms-notify";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { LEGAL_LINKS } from "@/components/legal/legal-links";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { NewTabHint } from "@/components/ui/new-tab";
import { requireSuperAdmin } from "@/lib/auth";
import { LEGAL_VERSION, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, getLegalInfo } from "@/lib/legal";
import { legalNoticeGaps } from "@/lib/legal-notice";

export const metadata: Metadata = { title: "Informations légales" };
export const dynamic = "force-dynamic";

const KEYS = [
  "company_name", "legal_form", "share_capital", "address", "registration", "vat_number", "publication_director",
  "email", "phone", "privacy_email", "host_name", "host_address", "host_phone", "data_host",
] as const;

export default async function AdminLegalPage() {
  const session = await requireSuperAdmin();
  const [{ data }, { data: orgs }, { data: accepted }, { data: notices }] = await Promise.all([
    session.supabase.from("platform_legal").select(KEYS.join(", ")).maybeSingle(),
    session.supabase.from("organizations").select("id, name").neq("status", "archived").order("name"),
    // CGV + accord de traitement au nom de chaque organisation (« dpa » suffit : les deux sont enregistrés ensemble)
    session.supabase.from("legal_acceptances").select("organization_id, version").eq("document", "dpa").not("organization_id", "is", null),
    // Annonces par e-mail déjà envoyées pour la version en vigueur (une par organisation, svc_org_terms_notify)
    session.supabase.from("org_terms_notices").select("organization_id, created_at").eq("version", ORG_LEGAL_VERSION),
  ]);
  const row = (data ?? {}) as Record<string, string | null>;
  const initial = Object.fromEntries(KEYS.map((k) => [k, row[k] ?? ""])) as Record<(typeof KEYS)[number], string>;
  // Mentions obligatoires manquantes (valeurs publiées : /admin/legal, à défaut LEGAL_NAME, LEGAL_EMAIL, LEGAL_ADDRESS)
  const published = await getLegalInfo();
  const gaps = legalNoticeGaps({ ...published, companyName: published.nameSet ? published.name : "" });
  const requiredGaps = gaps.filter((g) => g.required);
  const versions = new Map<string, string[]>();
  for (const a of (accepted ?? []) as { organization_id: string; version: string }[]) {
    versions.set(a.organization_id, [...(versions.get(a.organization_id) ?? []), a.version]);
  }
  const list = (orgs ?? []) as { id: string; name: string }[];
  // Version en vigueur (ORG_LEGAL_VERSION) acceptée, version antérieure seulement (« mise à jour ») ou jamais
  const missing = list
    .map((o) => ({ ...o, state: legalAcceptanceState(versions.get(o.id) ?? [], ORG_LEGAL_VERSION) }))
    .filter((o): o is { id: string; name: string; state: Exclude<LegalAcceptanceState, "accepted"> } => o.state !== "accepted");
  const notified = new Map(((notices ?? []) as { organization_id: string; created_at: string }[]).map((n) => [n.organization_id, n.created_at]));
  const toNotify = missing.filter((o) => !notified.has(o.id)).length;
  // L'annonce dit « au plus tard le … » : plus envoyée une fois cette date atteinte (heure de Paris, comme la base)
  const effectivePassed = localIsoDay(new Date(), "Europe/Paris") >= ORG_LEGAL_EFFECTIVE_AT;
  // CGV art. 16 : une modification défavorable est annoncée au moins 30 jours avant son entrée en vigueur. Annoncée
  // aujourd'hui, la version ne pourrait entrer en vigueur avant `minDay` (premier minuit, heure de Paris, après
  // maintenant + 30 jours : même règle que svc_org_terms_notify, qui refuse l'envoi) ; ORG_LEGAL_EFFECTIVE_AT à repousser.
  const minDay = noticeMinDay(new Date(), "Europe/Paris");
  const shortNotice = !effectivePassed && minDay > ORG_LEGAL_EFFECTIVE_AT;

  return (
    <>
      <PageHeader
        title="Informations légales"
        description="Éditeur et hébergeurs affichés dans les pages légales publiques, à faire valider par un professionnel du droit."
      />
      <PageBody>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <Card className={requiredGaps.length ? "border-amber/40" : undefined}>
              <CardHeader
                icon={requiredGaps.length ? <TriangleAlert className="text-amber" /> : <CircleCheck className="text-brand" />}
                title={requiredGaps.length ? `Mentions obligatoires manquantes : ${requiredGaps.length}` : "Mentions obligatoires renseignées"}
                description={
                  requiredGaps.length
                    ? "Affichées « à compléter par l'éditeur » sur /mentions-legales. LCEN, article 1-1 : jusqu'à 375 000 € d'amende pour une personne morale (article 1-2)."
                    : "Éditeur, directeur de la publication, contact et hébergeur figurent sur /mentions-legales."
                }
              />
              {gaps.length > 0 && (
                <CardBody>
                  <ul className="space-y-1.5 text-[13px]">
                    {gaps.map((g) => (
                      <li key={g.key} className="flex items-start gap-2">
                        <span aria-hidden className={g.required ? "mt-1.5 size-1.5 shrink-0 rounded-full bg-amber" : "mt-1.5 size-1.5 shrink-0 rounded-full bg-fg-muted"} />
                        <span className={g.required ? "text-fg" : "text-fg-muted"}>
                          {g.label}
                          {g.required ? "" : " (recommandé)"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              )}
            </Card>
            <LegalInfoForm initial={initial} />
          </div>
          <div className="space-y-6">
            <Card>
              <CardHeader
                title="Pages publiques"
                description={`CGU et confidentialité (tous les utilisateurs)\u00a0: version du ${legalDateLabel(LEGAL_VERSION)}. CGV et accord de traitement (clients)\u00a0: version du ${legalDateLabel(ORG_LEGAL_VERSION)}.`}
              />
              <CardBody className="space-y-1.5 text-[13px]">
                {LEGAL_LINKS.map((l) => (
                  <Link key={l.href} href={l.href} prefetch={false} target="_blank" className="block text-brand hover:underline">
                    {l.label} <span aria-hidden>↗</span>
                    <NewTabHint />
                  </Link>
                ))}
                <Link href="/suppression-compte" prefetch={false} target="_blank" className="block text-brand hover:underline">
                  Supprimer son compte <span aria-hidden>↗</span>
                  <NewTabHint />
                </Link>
              </CardBody>
            </Card>
            <Card>
              <CardHeader
                title="CGV et accord de traitement"
                description={`${formatNumber(list.length - missing.length)} client${list.length - missing.length > 1 ? "s" : ""} sur ${formatNumber(list.length)} ${list.length - missing.length > 1 ? "ont" : "a"} accepté la version du ${legalDateLabel(ORG_LEGAL_VERSION)}.`}
              />
              <CardBody className="text-[13px] text-fg-muted">
                {missing.length > 0 && (
                  <div className="mb-3 space-y-2 border-b border-line pb-3">
                    <p>
                      {effectivePassed
                        ? "Entrée en vigueur atteinte\u00a0: l'annonce par e-mail n'est plus envoyée."
                        : `${formatNumber(missing.length - toNotify)} prévenu${missing.length - toNotify > 1 ? "s" : ""} par e-mail sur ${formatNumber(missing.length)} en attente.`}
                    </p>
                    {shortNotice && (
                      <Callout tone="warning" title="Envoi bloqué" className="text-[13px]">
                        Annoncée aujourd&apos;hui, la version ne pourrait entrer en vigueur avant le {legalDateLabel(minDay)}, et l&apos;annonce
                        dit «{"\u00a0"}au plus tard le {legalDateLabel(ORG_LEGAL_EFFECTIVE_AT)}{"\u00a0"}» (article 16 des CGV{"\u00a0"}: au moins
                        30 jours avant). Demandez à votre équipe technique de repousser la date d&apos;entrée en vigueur au{" "}
                        {legalDateLabel(minDay)} au plus tôt.
                      </Callout>
                    )}
                    <OrgTermsNotifyButton toNotify={toNotify} effectivePassed={effectivePassed} shortNotice={shortNotice} />
                  </div>
                )}
                {missing.length === 0 ? (
                  <p>Tous les clients ont accepté.</p>
                ) : (
                  <>
                    <p className="mb-2">En attente (bandeau affiché au propriétaire et aux administrateurs){"\u00a0"}:</p>
                    <ul className="space-y-1">
                      {missing.slice(0, 30).map((o) => (
                        <li key={o.id}>
                          <Link href={`/admin/organizations/${o.id}`} prefetch={false} className="hover:text-fg">
                            {o.name}
                          </Link>
                          {o.state === "updated" ? " · version antérieure acceptée" : " · aucune version acceptée"}
                          {notified.has(o.id) ? ` · prévenu le ${formatDate(notified.get(o.id))}` : ""}
                        </li>
                      ))}
                    </ul>
                    {missing.length > 30 && <p className="mt-2">… et {formatNumber(missing.length - 30)} autres.</p>}
                  </>
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  );
}
