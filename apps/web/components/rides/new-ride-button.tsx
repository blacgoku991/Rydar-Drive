"use client";
import type { PricingRule } from "@rydar/shared";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NewRideSheet } from "@/components/rides/new-ride-sheet";
import { Button } from "@/components/ui/button";

export function NewRideButton({ pricing, defaultPayment }: { pricing: PricingRule[]; defaultPayment?: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus /> Nouvelle course
      </Button>
      <NewRideSheet
        open={open}
        onOpenChange={setOpen}
        pricing={pricing}
        defaultPayment={defaultPayment}
        onCreated={(r) => router.push(`/dashboard/rides/${r.id}`)}
      />
    </>
  );
}
