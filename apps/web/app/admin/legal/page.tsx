import { formatDate, legalAcceptanceState, legalDateLabel, localIsoDay, type LegalAcceptanceState } from "@rydar/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalInfoForm } from "@/components/admin/legal-form";
import { OrgTermsNotifyButton } from "@/components/admin/org-terms-notify";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { LEGAL_LINKS } from "@/components/legal/legal-links";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";
import { LEGAL_VERSION, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION } from "@/lib/legal";

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
  // aujourd'hui, elle laisserait moins de 30 jours (ORG_LEGAL_EFFECTIVE_AT à repousser avant d'envoyer).
  const shortNotice = !effectivePassed && localIsoDay(new Date(Date.now() + 30 * 86_400_000), "Europe/Paris") >= ORG_LEGAL_EFFECTIVE_AT;

  return (
    <>
      <PageHeader
        eyebrow="Plateforme"
        title="Informations légales"
        description="Éditeur et hébergeurs affichés dans les pages légales publiques. À faire valider par un professionnel du droit avant l'ouverture au public."
      />
      <PageBody>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <LegalInfoForm initial={initial} />
          <div className="space-y-6">
            <Card>
              <CardHeader
                title="Pages publiques"
                description={`Versions : CGU et confidentialité ${LEGAL_VERSION} (tout utilisateur) · CGV et accord de traitement ${ORG_LEGAL_VERSION} (organisations).`}
              />
              <CardBody className="space-y-1.5 text-[13px]">
                {LEGAL_LINKS.map((l) => (
                  <Link key={l.href} href={l.href} target="_blank" className="block text-brand hover:underline">
                    {l.label} ↗
                  </Link>
                ))}
                <Link href="/suppression-compte" target="_blank" className="block text-brand hover:underline">
                  Supprimer son compte ↗
                </Link>
              </CardBody>
            </Card>
            <Card>
              <CardHeader
                title="CGV et accord de traitement"
                description={`${list.length - missing.length} / ${list.length} organisation${list.length > 1 ? "s" : ""} ont accepté la version ${ORG_LEGAL_VERSION}.`}
              />
              <CardBody className="text-[13px] text-fg-muted">
                {missing.length > 0 && (
                  <div className="mb-3 space-y-2 border-b border-line pb-3">
                    <p>
                      {effectivePassed
                        ? "Entrée en vigueur atteinte\u00a0: l'annonce par e-mail n'est plus envoyée."
                        : `${missing.length - toNotify} prévenue${missing.length - toNotify > 1 ? "s" : ""} par e-mail sur ${missing.length} en attente.`}
                    </p>
                    {shortNotice && (
                      <p className="text-amber">
                        Moins de 30 jours avant le {legalDateLabel(ORG_LEGAL_EFFECTIVE_AT)}{"\u00a0"}: l&apos;article 16 des CGV
                        demande d&apos;annoncer une modification défavorable au moins 30 jours avant son entrée en vigueur.
                        Repoussez d&apos;abord la date (ORG_LEGAL_EFFECTIVE_AT, @rydar/shared) puis redéployez.
                      </p>
                    )}
                    <OrgTermsNotifyButton toNotify={toNotify} effectivePassed={effectivePassed} shortNotice={shortNotice} />
                  </div>
                )}
                {missing.length === 0 ? (
                  <p>Toutes les organisations ont accepté.</p>
                ) : (
                  <>
                    <p className="mb-2">En attente (bandeau affiché au propriétaire et aux administrateurs) :</p>
                    <ul className="space-y-1">
                      {missing.slice(0, 30).map((o) => (
                        <li key={o.id}>
                          <Link href={`/admin/organizations/${o.id}`} className="hover:text-fg">
                            {o.name}
                          </Link>
                          {o.state === "updated" ? " · version antérieure acceptée" : " · aucune version acceptée"}
                          {notified.has(o.id) ? ` · prévenue le ${formatDate(notified.get(o.id))}` : ""}
                        </li>
                      ))}
                    </ul>
                    {missing.length > 30 && <p className="mt-2">… et {missing.length - 30} autres.</p>}
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
