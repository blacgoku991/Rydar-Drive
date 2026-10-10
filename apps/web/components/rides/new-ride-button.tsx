"use client";
import type { PricingRule } from "@rydar/shared";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NewRideSheet } from "@/components/rides/new-ride-sheet";
import { Button } from "@/components/ui/button";

/**
 * `privateFleet` : « Nouvelle réservation (téléphone) », attribuée d'office au chauffeur-propriétaire. `center` : centre
 * de l'activité (proximité des suggestions d'adresses, raccourcis parisiens seulement en Île-de-France).
 */
export function NewRideButton({
  pricing,
  defaultPayment,
  privateFleet = false,
  center,
}: {
  pricing: PricingRule[];
  defaultPayment?: string;
  privateFleet?: boolean;
  center?: { lat: number; lng: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus /> {privateFleet ? "Nouvelle réservation (téléphone)" : "Nouvelle course"}
      </Button>
      <NewRideSheet
        open={open}
        onOpenChange={setOpen}
        pricing={pricing}
        defaultPayment={defaultPayment}
        privateFleet={privateFleet}
        center={center}
        onCreated={(r) => router.push(`/dashboard/rides/${r.id}`)}
      />
    </>
  );
}
