"use client";
import type { PricingRule } from "@rydar/shared";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NewRideSheet } from "@/components/rides/new-ride-sheet";
import { Button } from "@/components/ui/button";

/** `privateFleet` : « Nouvelle réservation (téléphone) », attribuée d'office au chauffeur-propriétaire. */
export function NewRideButton({ pricing, defaultPayment, privateFleet = false }: { pricing: PricingRule[]; defaultPayment?: string; privateFleet?: boolean }) {
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
        onCreated={(r) => router.push(`/dashboard/rides/${r.id}`)}
      />
    </>
  );
}
