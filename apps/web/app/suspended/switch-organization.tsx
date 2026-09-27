"use client";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { switchOrganization } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";

/** Membre de plusieurs centrales : passer à une centrale active depuis l'écran « Compte suspendu ». */
export function SwitchOrganization({ orgs }: { orgs: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="mt-6 space-y-2 text-left">
      <p className="text-[13px] text-fg-muted">Vos autres centrales :</p>
      {orgs.map((o) => (
        <Button
          key={o.id}
          variant="secondary"
          className="w-full justify-between"
          loading={pending}
          onClick={() =>
            start(async () => {
              await switchOrganization(o.id);
              router.push("/dashboard");
              router.refresh();
            })
          }
        >
          <span className="truncate">{o.name}</span> <ArrowRight />
        </Button>
      ))}
    </div>
  );
}
