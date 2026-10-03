"use client";
// Tableau de la page Chauffeurs, alimenté par des lignes compactes : la page n'envoie au navigateur que ces données
// (et non l'arbre complet du tableau rendu côté serveur, qui doublait le poids de la page).
import {
  DRIVER_STATUS_META, VEHICLE_CATEGORY_META, formatPercent, formatPhone, formatPrice, formatRelative,
  type DriverStatus, type VehicleCategory,
} from "@rydar/shared";
import Link from "next/link";
import { PresenceBadge } from "@/components/rides/status";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";

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
  offers: number | string;
  completed: number | string;
  cancelled: number | string;
  revenue_cents: number;
};

/** `serverNow` : heure du rendu serveur (« vu il y a » identique au rendu serveur et à l'hydratation). */
export function DriversTable({ rows, serverNow }: { rows: DriverTableRow[]; serverNow: number }) {
  const now = new Date(serverNow);
  return (
    <Table>
      <THead>
        <tr>
          <TH>Chauffeur</TH>
          <TH>Véhicule</TH>
          <TH>Présence</TH>
          <TH className="text-right">Acceptation</TH>
          <TH className="text-right">Terminées</TH>
          <TH className="text-right">Annulées</TH>
          <TH className="text-right">CA 30 j</TH>
          <TH>Compte</TH>
        </tr>
      </THead>
      <tbody>
        {rows.map((d) => {
          const rate = d.rate;
          return (
            <TR key={d.id} className="relative">
              <TD>
                <Link href={`/dashboard/drivers/${d.id}`} prefetch={false} className="absolute inset-0" aria-label={`${d.first_name} ${d.last_name}`} />
                <div className="flex items-center gap-3">
                  <Avatar name={`${d.first_name} ${d.last_name}`} src={d.photo_url} size={34} />
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium">
                      {d.first_name} {d.last_name} <span className="num text-[11.5px] text-fg-subtle">#{d.number}</span>
                    </p>
                    <p className="text-[12px] text-fg-subtle">{formatPhone(d.phone)}</p>
                  </div>
                </div>
              </TD>
              <TD>
                <p className="text-[13px]">{d.vehicle ? `${d.vehicle.brand ?? ""} ${d.vehicle.model}` : "—"}</p>
                <p className="text-[12px] text-fg-subtle">
                  <span className="num">{d.vehicle?.plate}</span> · {d.vehicle ? VEHICLE_CATEGORY_META[d.vehicle.category as VehicleCategory]?.label : ""}
                </p>
              </TD>
              <TD>
                <PresenceBadge presence={d.presence} />
                <p className="mt-1 text-[11px] text-fg-subtle">{d.seen_at ? `vu ${formatRelative(d.seen_at, now)}` : "jamais connecté"}</p>
              </TD>
              <TD className="text-right">
                <span className={cn("num text-[13.5px] font-semibold", rate == null ? "text-fg-subtle" : rate >= 0.6 ? "text-brand" : rate >= 0.35 ? "text-amber" : "text-red")}>
                  {formatPercent(rate)}
                </span>
                <p className="num text-[11px] text-fg-subtle">{d.offers} offres</p>
              </TD>
              <TD className="num text-right text-[13.5px]">{d.completed}</TD>
              <TD className="num text-right text-[13.5px] text-fg-muted">{d.cancelled}</TD>
              <TD className="num text-right text-[13.5px] font-semibold">{formatPrice(d.revenue_cents)}</TD>
              <TD>
                <Badge tone={DRIVER_STATUS_META[d.status].tone}>{DRIVER_STATUS_META[d.status].label}</Badge>
              </TD>
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}
