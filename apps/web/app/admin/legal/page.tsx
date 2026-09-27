import type { Metadata } from "next";
import Link from "next/link";
import { LegalInfoForm } from "@/components/admin/legal-form";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { LEGAL_LINKS } from "@/components/legal/legal-links";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";
import { LEGAL_VERSION } from "@/lib/legal";

export const metadata: Metadata = { title: "Informations légales" };
export const dynamic = "force-dynamic";

const KEYS = [
  "company_name", "legal_form", "share_capital", "address", "registration", "vat_number", "publication_director",
  "email", "phone", "privacy_email", "host_name", "host_address", "host_phone", "data_host",
] as const;

export default async function AdminLegalPage() {
  const session = await requireSuperAdmin();
  const [{ data }, { data: orgs }, { data: accepted }] = await Promise.all([
    session.supabase.from("platform_legal").select(KEYS.join(", ")).maybeSingle(),
    session.supabase.from("organizations").select("id, name").neq("status", "archived").order("name"),
    session.supabase.from("legal_acceptances").select("organization_id, document, version, accepted_at").in("document", ["cgv", "dpa"]).not("organization_id", "is", null),
  ]);
  const row = (data ?? {}) as Record<string, string | null>;
  const initial = Object.fromEntries(KEYS.map((k) => [k, row[k] ?? ""])) as Record<(typeof KEYS)[number], string>;
  const current = new Set(
    (accepted ?? [])
      .filter((a) => a.version === LEGAL_VERSION && a.document === "dpa")
      .map((a) => a.organization_id as string),
  );
  const list = (orgs ?? []) as { id: string; name: string }[];
  const missing = list.filter((o) => !current.has(o.id));

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
              <CardHeader title="Pages publiques" description={`Version des documents : ${LEGAL_VERSION}`} />
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
                description={`${list.length - missing.length} / ${list.length} organisation${list.length > 1 ? "s" : ""} ont accepté la version en vigueur.`}
              />
              <CardBody className="text-[13px] text-fg-muted">
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
