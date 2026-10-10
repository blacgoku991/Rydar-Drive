import { VEHICLE_CATEGORY_META, formatPhone, type VehicleCategory } from "@rydar/shared";
import { Car, IdCard, UserX } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DriverControls } from "@/components/drivers/driver-controls";
import { DriverDocuments } from "@/components/drivers/driver-documents";
import { DOCUMENT_COLUMNS, buildDocumentView, fileKind, type DocumentRow, type DocumentView } from "@/components/drivers/documents";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { appPresence } from "@/components/private-fleet/booking-meta";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";
import { upperFirst } from "@/lib/wording";

export const metadata: Metadata = { title: "Mon profil chauffeur" };
export const dynamic = "force-dynamic";

type Ctx = Awaited<ReturnType<typeof requireOrg>>;

const DESCRIPTION = "Votre fiche chauffeur\u00a0: identité, carte VTC, véhicule et documents.";

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

function Item({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-fg-muted">{label}</p>
      {/* Texte long (e-mail) : coupé n'importe où plutôt que de déborder */}
      <p className="text-[13.5px] text-fg [overflow-wrap:anywhere]">{children}</p>
      {hint && <p className="mt-0.5 text-[12px] text-fg-muted">{hint}</p>}
    </div>
  );
}

/**
 * « Mon profil chauffeur » (Flotte Privée, docs/FLOTTE-PRIVEE.md § 7.3) : identité, carte VTC, véhicule, documents et
 * échéances de la fiche du propriétaire (updateDriver, addDriverDocument, validation de ses dépôts). Aucune action de
 * statut, de bannissement, de niveau de confiance, de mot de passe ni de session. Organisation standard : « Chauffeurs ».
 */
export default async function ProfilePage() {
  const ctx = await requireOrg();
  if (!isPrivateFleet(ctx.org)) redirect("/dashboard/drivers");
  const header = <PageHeader title="Mon profil chauffeur" description={DESCRIPTION} />;
  const driverId = ctx.driverId;
  const [{ data: d }, { data: docs }] = driverId
    ? await Promise.all([
        ctx.supabase
          .from("drivers")
          .select("id, first_name, last_name, phone, email, vtc_card_number, notes, status, presence, last_seen_at, vehicle:vehicles(brand, model, color, plate, category, seats, luggage_capacity)")
          .eq("id", driverId)
          .eq("organization_id", ctx.org.id)
          .maybeSingle(),
        ctx.supabase.from("driver_documents").select(DOCUMENT_COLUMNS).eq("organization_id", ctx.org.id).eq("driver_id", driverId),
      ])
    : [{ data: null }, { data: null }];

  if (!d) {
    return (
      <>
        {header}
        <PageBody>
          <Card>
            <CardBody className="flex items-start gap-4">
              <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-fg-muted">
                <UserX className="size-5" />
              </span>
              <p className="text-[14px] text-fg">Votre fiche chauffeur a été supprimée&nbsp;: contactez l&apos;équipe Rydar pour la recréer.</p>
            </CardBody>
          </Card>
        </PageBody>
      </>
    );
  }

  const tz = ctx.org.timezone || "Europe/Paris";
  const vehicle = (Array.isArray(d.vehicle) ? d.vehicle[0] : d.vehicle) as {
    brand: string | null; model: string; color: string | null; plate: string; category: string; seats: number; luggage_capacity: number;
  } | null;
  const docView = buildDocumentView((docs ?? []) as unknown as DocumentRow[], tz);
  const documents: DocumentView[] = await Promise.all(
    docView.items.map(async (doc) => ({ ...doc, kind: fileKind(doc.file_path), url: doc.file_path ? await signedUrl(ctx.supabase, doc.file_path) : null })),
  );
  const presence = appPresence({ status: d.status, presence: d.presence, last_seen_at: d.last_seen_at }, Date.now());
  // Application : « Jamais ouverte » (avec la marche à suivre), sinon l'état ou la dernière activité
  const neverOpened = !d.last_seen_at;

  return (
    <>
      <LiveRefresh driverId={d.id} events={["driver.updated"]} pollMs={30_000} />
      <PageHeader
        title="Mon profil chauffeur"
        description={DESCRIPTION}
        actions={
          <DriverControls
            self
            canManage={false}
            driver={{
              id: d.id,
              status: d.status,
              first_name: d.first_name,
              last_name: d.last_name,
              phone: d.phone,
              email: d.email,
              vtc_card_number: d.vtc_card_number,
              notes: d.notes,
              vehicle,
            }}
          />
        }
      />
      <PageBody className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title={`${d.first_name} ${d.last_name}`}
              icon={<IdCard />}
              description="Identité et carte professionnelle"
              action={<Badge tone={presence.tone}>{presence.label}</Badge>}
            />
            <CardBody className="grid grid-cols-2 gap-4">
              <Item label="Téléphone">{formatPhone(d.phone)}</Item>
              <Item label="E-mail de contact">{d.email ?? "—"}</Item>
              <Item label="N° de carte VTC">
                <span className="num">{d.vtc_card_number ?? "—"}</span>
              </Item>
              <Item label="Application" hint={neverOpened ? "Connectez-vous à l'application avec les mêmes identifiants." : undefined}>
                {neverOpened ? "Jamais ouverte" : upperFirst(presence.detail ?? presence.label)}
              </Item>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Véhicule" icon={<Car />} description={`Les réservations d'une autre catégorie ou de plus de places sont «\u00a0à vérifier\u00a0».`} />
            <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Item label="Modèle">{vehicle ? `${vehicle.brand ?? ""} ${vehicle.model}`.trim() : "—"}</Item>
              <Item label="Plaque">
                <span className="num">{vehicle?.plate ?? "—"}</span>
              </Item>
              <Item label="Couleur">{vehicle?.color ?? "—"}</Item>
              <Item label="Catégorie">{vehicle ? VEHICLE_CATEGORY_META[vehicle.category as VehicleCategory]?.label : "—"}</Item>
              <Item label="Places">
                <span className="num">{vehicle?.seats ?? "—"}</span>
              </Item>
              <Item label="Bagages">
                <span className="num">{vehicle?.luggage_capacity ?? "—"}</span>
              </Item>
            </CardBody>
          </Card>
        </div>
        <DriverDocuments self canAdd driverId={d.id} firstName={d.first_name} items={documents} missing={docView.missing} canReview />
      </PageBody>
    </>
  );
}
