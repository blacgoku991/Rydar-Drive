"use client";
// Liste de la page Chauffeurs, alimentée par des lignes compactes : la page n'envoie au navigateur que ces données
// (et non l'arbre complet du tableau rendu côté serveur, qui doublait le poids de la page). Sous 768 px, une carte par
// chauffeur (toute la carte mène à sa fiche) ; à partir de 768 px, le tableau (docs/REFONTE-PANELS.md § 3.4).
import {
  DRIVER_STATUS_META, VEHICLE_CATEGORY_META, formatPercent, formatPhone, formatPrice, formatRelative,
  type DriverStatus, type VehicleCategory,
} from "@rydar/shared";
import Link from "next/link";
import { PresenceBadge } from "@/components/rides/status";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { DesktopTable, ListCard, MobileList, Table, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";

export type DriverTableRow = {
  id: string;
  number: number;
  first_name: string;
  last_name: string;
  phone: string;
  photo_url: string | null;
  status: DriverStatus;
  presence: string;
  vehicle: { brand: string | null; model: string; plate: string; category: string } | null;
  /** Dernière position (updated_at) */
  seen_at: string | null;
  /** Indicateurs 30 jours (org_driver_metrics) */
  rate: number | null;
  /** Courses proposées au chauffeur (offres reçues) */
  offers: number;
  completed: number;
  cancelled: number;
  revenue_cents: number;
};

/** Statut du compte, affiché seulement s'il n'est pas actif (la colonne « Compte » répétait « Actif » partout). */
function AccountBadge({ status }: { status: DriverStatus }) {
  if (status === "active") return null;
  const meta = DRIVER_STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

const vehicleLabel = (v: DriverTableRow["vehicle"]) => (v ? `${v.brand ? `${v.brand} ` : ""}${v.model}` : "—");
const categoryLabel = (v: DriverTableRow["vehicle"]) => (v ? (VEHICLE_CATEGORY_META[v.category as VehicleCategory]?.label ?? v.category) : null);

/** `serverNow` : heure du rendu serveur (« vu il y a » identique au rendu serveur et à l'hydratation). */
export function DriversTable({ rows, serverNow }: { rows: DriverTableRow[]; serverNow: number }) {
  const now = new Date(serverNow);
  const seen = (d: DriverTableRow) => (d.seen_at ? `vu ${formatRelative(d.seen_at, now)}` : "jamais connecté");
  return (
    <>
      {/* Téléphone : nom et présence ; plaque · catégorie ; terminées · chiffre d'affaires */}
      <MobileList>
        {rows.map((d) => {
          const name = `${d.first_name} ${d.last_name}`;
          const category = categoryLabel(d.vehicle);
          return (
            <ListCard
              key={d.id}
              href={`/dashboard/drivers/${d.id}`}
              aria-label={`${name}, n° ${d.number}`}
              title={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    {name} <span className="num text-[12px] font-normal text-fg-muted">#{d.number}</span>
                  </span>
                  <AccountBadge status={d.status} />
                </span>
              }
              status={<PresenceBadge presence={d.presence} />}
              lines={[
                d.vehicle ? (
                  <span>
                    <span className="num">{d.vehicle.plate}</span>
                    {category ? ` · ${category}` : ""}
                  </span>
                ) : (
                  "Aucun véhicule"
                ),
                <span>
                  {plural(d.completed, "course terminée", "courses terminées")} ·{" "}
                  <span className="num font-medium text-fg">{formatPrice(d.revenue_cents)}</span> <span className="text-fg-muted">(30 j)</span>
                </span>,
              ]}
            />
          );
        })}
      </MobileList>
      <DesktopTable>
        <Table>
          <THead>
            <tr>
              <TH>Chauffeur</TH>
              <TH>Véhicule</TH>
              <TH>Présence</TH>
              <TH className="text-right">Acceptation</TH>
              <TH className="text-right">Terminées</TH>
              <TH className="text-right">Annulées</TH>
              <TH className="text-right">Chiffre d&apos;affaires (30 j)</TH>
            </tr>
          </THead>
          <tbody>
            {rows.map((d) => {
              const rate = d.rate;
              const name = `${d.first_name} ${d.last_name}`;
              return (
                <TR key={d.id} className="relative">
                  <TD>
                    <Link href={`/dashboard/drivers/${d.id}`} prefetch={false} className="absolute inset-0" aria-label={name} />
                    <div className="flex items-center gap-3">
                      <Avatar name={name} src={d.photo_url} size={34} />
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-medium">
                          <span className="truncate">
                            {name} <span className="num text-[12px] font-normal text-fg-muted">#{d.number}</span>
                          </span>
                          <AccountBadge status={d.status} />
                        </p>
                        <p className="text-[12px] text-fg-muted">{formatPhone(d.phone)}</p>
                      </div>
                    </div>
                  </TD>
                  <TD>
                    <p className="text-[13px]">{vehicleLabel(d.vehicle)}</p>
                    {d.vehicle && (
                      <p className="text-[12px] text-fg-muted">
                        <span className="num">{d.vehicle.plate}</span>
                        {categoryLabel(d.vehicle) ? ` · ${categoryLabel(d.vehicle)}` : ""}
                      </p>
                    )}
                  </TD>
                  <TD>
                    <PresenceBadge presence={d.presence} />
                    <p className="mt-1 whitespace-nowrap text-[12px] text-fg-muted">{seen(d)}</p>
                  </TD>
                  <TD className="text-right">
                    <span className={cn("num text-[13.5px] font-semibold", rate == null ? "text-fg-muted" : rate >= 0.6 ? "text-fg" : rate >= 0.35 ? "text-amber" : "text-red")}>
                      {formatPercent(rate)}
                    </span>
                    <p className="whitespace-nowrap text-[12px] text-fg-muted">{plural(d.offers, "course proposée", "courses proposées")}</p>
                  </TD>
                  <TD className="num text-right text-[13.5px]">{d.completed}</TD>
                  <TD className="num text-right text-[13.5px] text-fg-muted">{d.cancelled}</TD>
                  <TD className="num whitespace-nowrap text-right text-[13.5px] font-semibold">{formatPrice(d.revenue_cents)}</TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </DesktopTable>
    </>
  );
}
