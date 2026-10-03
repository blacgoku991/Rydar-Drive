"use client";
// En direct (organisation qui confie la course, A) : chauffeur partenaire de la course sélectionnée, relu
// (org_network_ride) quand la course change — libellé court, organisation, véhicule, téléphone dans sa fenêtre.
// Aucune position du partenaire en v1 (ni marqueur, ni trajet d'approche). Course encore en recherche : compteur des
// partenaires sollicités seulement.
import { formatPhone, type OrgNetworkRide } from "@rydar/shared";
import { ArrowLeftRight, ExternalLink, Phone } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getBrowserClient } from "@/lib/supabase/client";

export function LivePartnerCard({ rideId, version, label }: { rideId: string; version: string; label: string }) {
  const [state, setState] = useState<{ rideId: string; data: OrgNetworkRide | null; failed: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    getBrowserClient()
      .rpc("org_network_ride", { p_ride: rideId })
      .then(
        ({ data, error }: { data: unknown; error: unknown }) => alive && setState({ rideId, data: error ? null : ((data ?? null) as OrgNetworkRide | null), failed: !!error }),
        () => alive && setState({ rideId, data: null, failed: true }),
      );
    return () => {
      alive = false;
    };
  }, [rideId, version]);

  const current = state?.rideId === rideId ? state : null;
  const e = current?.data?.execution && !current.data.execution.ended_at ? current.data.execution : null;
  const asked = current?.data?.share?.partners_offered ?? 0;
  return (
    <div className="rounded-xl border border-violet/25 bg-violet/[0.05] px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-violet">
        <ArrowLeftRight className="size-3.5" /> {label.charAt(0).toUpperCase() + label.slice(1)}
      </p>
      {!current ? (
        <div className="skeleton mt-2 h-9 rounded-lg" aria-hidden />
      ) : e ? (
        <div className="mt-1.5 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium text-fg">{e.driver_label}</p>
            <p className="truncate text-[12px] text-fg-subtle">
              {[e.vehicle.brand, e.vehicle.model].filter(Boolean).join(" ")}
              {e.vehicle.plate ? ` · ${e.vehicle.plate}` : ""}
            </p>
          </div>
          {e.driver_phone && (
            <Button asChild variant="secondary" size="icon-sm" aria-label={`Appeler ${e.driver_label} (${formatPhone(e.driver_phone)})`}>
              <a href={`tel:${e.driver_phone}`}>
                <Phone />
              </a>
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-1 text-[12.5px] text-fg-muted">
          {current.failed
            ? "Détails du chauffeur partenaire sur la fiche de la course."
            : asked > 0
              ? `${asked} chauffeur${asked > 1 ? "s" : ""} partenaire${asked > 1 ? "s" : ""} sollicité${asked > 1 ? "s" : ""} · vos chauffeurs restent prioritaires.`
              : "Recherche d'un chauffeur partenaire à proximité · vos chauffeurs restent prioritaires."}
        </p>
      )}
      <Link href={`/dashboard/rides/${rideId}`} prefetch={false} className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-fg-subtle hover:text-fg">
        Bloc « Réseau partagé » de la fiche <ExternalLink className="size-3" />
      </Link>
    </div>
  );
}
