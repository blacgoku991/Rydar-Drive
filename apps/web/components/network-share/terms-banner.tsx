"use client";
// Bandeau owner / admin « nouvelle convention du réseau partagé » (tableau de bord, toutes les pages) : affiché quand
// la convention a déjà été acceptée une fois mais pas sa version courante — pendant le délai de grâce (le réseau
// continue), ou après (le réseau est arrêté pour l'organisation). Jamais affiché quand le réseau est fermé.
import { NETWORK_DOCUMENTS, formatDate } from "@rydar/shared";
import { FileCheck2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { acceptNetworkTerms } from "@/app/dashboard/reseau-partage/actions";
import { Button } from "@/components/ui/button";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

export function NetworkTermsBanner({
  orgName, version, graceUntil, expired, timeZone,
}: {
  orgName: string;
  version: string;
  graceUntil: string | null;
  expired: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [checked, setChecked] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const submit = () =>
    checked &&
    start(() => runAction(async () => {
      const res = await acceptNetworkTerms(version);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message);
      setHidden(true);
      router.refresh();
    }));
  return (
    <form
      onSubmit={submitWith(submit)}
      role="region"
      aria-label="Nouvelle convention du réseau partagé"
      className={expired ? "border-b border-line bg-amber/[0.06] px-4 py-3 sm:px-6" : "border-b border-line bg-blue/[0.06] px-4 py-3 sm:px-6"}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <FileCheck2 className={expired ? "mt-0.5 size-5 shrink-0 text-amber" : "mt-0.5 size-5 shrink-0 text-blue"} />
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-fg-muted">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]" />
            <span>
              {expired
                ? "Le réseau partagé est arrêté pour votre organisation tant que la nouvelle convention n'est pas acceptée. "
                : `Nouvelle convention du réseau partagé${graceUntil ? `, à accepter avant le ${formatDate(graceUntil, timeZone)}` : ""}. `}
              J&apos;accepte, au nom de <span className="text-fg">{orgName}</span>, la{" "}
              <a href={NETWORK_DOCUMENTS.network.path} target="_blank" rel="noopener" className="text-fg underline underline-offset-2">
                convention du réseau partagé
              </a>{" "}
              (version {version}).
            </span>
          </label>
        </div>
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!checked} className="self-end lg:self-auto">
          Accepter
        </Button>
      </div>
    </form>
  );
}
