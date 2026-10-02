"use client";
// Bandeaux d'acceptation des conditions (version en vigueur), non bloquants : le dispatch continue pendant ce temps.
// Un seul à la fois (dashboard/layout.tsx) :
//  - TermsBanner (owner / admin) : CGV + accord de traitement des données (art. 28 RGPD) au nom de la centrale, et à
//    titre personnel CGU + politique de confidentialité ;
//  - UserTermsBanner (tout membre, dispatcher compris) : CGU + politique de confidentialité à titre personnel.
import { FileCheck2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { acceptOrgTerms, acceptUserTerms } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";
import { runAction } from "@/lib/run-action";

const link = "text-fg underline underline-offset-2";

/** Case à cocher + « Accepter » : enregistre l'acceptation puis relit la mise en page. */
function AcceptBanner({ accept, children }: { accept: () => Promise<{ ok: true } | { ok: false; error: string }>; children: React.ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [checked, setChecked] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const submit = () =>
    start(() => runAction(async () => {
      const res = await accept();
      if (!res.ok) return void toast.error(res.error);
      toast.success("Conditions acceptées");
      setHidden(true);
      router.refresh();
    }));
  return (
    <div role="region" aria-label="Conditions à accepter" className="border-b border-line bg-blue/[0.06] px-4 py-3 sm:px-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <FileCheck2 className="mt-0.5 size-5 shrink-0 text-blue" />
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-fg-muted">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]" />
            <span>{children}</span>
          </label>
        </div>
        <Button variant="primary" size="sm" loading={pending} disabled={!checked} onClick={submit} className="self-end lg:self-auto">
          Accepter
        </Button>
      </div>
    </div>
  );
}

/** Owner / admin : conditions de la centrale (et, pour lui-même, CGU + politique de confidentialité). */
export function TermsBanner({ orgName }: { orgName: string }) {
  return (
    <AcceptBanner accept={acceptOrgTerms}>
      J&apos;accepte, au nom de <span className="text-fg">{orgName}</span>, les{" "}
      <a href="/cgv" target="_blank" rel="noopener" className={link}>conditions générales de vente</a> et l&apos;
      <a href="/dpa" target="_blank" rel="noopener" className={link}>accord de traitement des données (RGPD)</a>, ainsi que les{" "}
      <a href="/cgu" target="_blank" rel="noopener" className={link}>conditions d&apos;utilisation</a> et la{" "}
      <a href="/confidentialite" target="_blank" rel="noopener" className={link}>politique de confidentialité</a>. Je confirme que la
      centrale respecte ses obligations de transporteur (inscription VTC, déclaration de centrale de réservation le cas échéant).
    </AcceptBanner>
  );
}

/** Tout membre du tableau de bord (dispatcher compris) : CGU + politique de confidentialité, à titre personnel. */
export function UserTermsBanner() {
  return (
    <AcceptBanner accept={acceptUserTerms}>
      J&apos;accepte les <a href="/cgu" target="_blank" rel="noopener" className={link}>conditions d&apos;utilisation</a> et la{" "}
      <a href="/confidentialite" target="_blank" rel="noopener" className={link}>politique de confidentialité</a> de Rydar Drive.
    </AcceptBanner>
  );
}
