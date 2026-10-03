"use client";
// Bandeaux d'acceptation des conditions (version en vigueur), non bloquants : le dispatch continue pendant ce temps.
// Un seul à la fois (dashboard/layout.tsx, choix : terms-state.ts) :
//  - TermsBanner (owner / admin) : CGV + accord de traitement des données (art. 28 RGPD) au nom de la centrale
//    (ORG_LEGAL_VERSION), et à titre personnel CGU + politique de confidentialité (LEGAL_VERSION) ; mode « mise à
//    jour » quand l'organisation avait accepté une version antérieure des CGV ;
//  - UserTermsBanner (tout membre, dispatcher compris) : CGU + politique de confidentialité à titre personnel.
import { ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, legalDateLabel } from "@rydar/shared";
import { FileCheck2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { acceptOrgTerms, acceptUserTerms } from "@/app/dashboard/actions";
import { Button } from "@/components/ui/button";
import { runAction } from "@/lib/run-action";

const link = "text-fg underline underline-offset-2";

/** Case à cocher + « Accepter » : enregistre l'acceptation puis relit la mise en page. `notice` : texte au-dessus. */
function AcceptBanner({
  accept,
  notice,
  children,
}: {
  accept: () => Promise<{ ok: true } | { ok: false; error: string }>;
  notice?: React.ReactNode;
  children: React.ReactNode;
}) {
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
          <div className="min-w-0 space-y-2">
            {notice ? <p className="text-[13px] leading-relaxed text-fg-muted">{notice}</p> : null}
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-fg-muted">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]" />
              <span>{children}</span>
            </label>
          </div>
        </div>
        <Button variant="primary" size="sm" loading={pending} disabled={!checked} onClick={submit} className="self-end lg:self-auto">
          Accepter
        </Button>
      </div>
    </div>
  );
}

/**
 * Ce qui change dans la version ORG_LEGAL_VERSION des CGV et sa date d'entrée en vigueur pour une organisation qui
 * avait accepté une version antérieure (texte provisoire, à finaliser avec le préambule des CGV).
 */
function OrgTermsUpdateNotice() {
  return (
    <>
      <span className="font-medium text-fg">
        Nouvelles conditions générales de vente (version du {legalDateLabel(ORG_LEGAL_VERSION)}) :
      </span>{" "}
      des frais plateforme par course peuvent s&apos;appliquer aux flottes comme aux centrales, en plus de l&apos;abonnement
      (articles 3 à 5). Pour votre organisation, elles s&apos;appliquent dès votre acceptation, et au plus tard le{" "}
      {legalDateLabel(ORG_LEGAL_EFFECTIVE_AT)} ; vous pouvez résilier sans frais avant cette date.
    </>
  );
}

/**
 * Owner / admin : conditions de la centrale (et, pour lui-même, CGU + politique de confidentialité). `updated` :
 * l'organisation avait accepté une version antérieure des CGV (mise à jour à accepter).
 */
export function TermsBanner({ orgName, updated = false }: { orgName: string; updated?: boolean }) {
  return (
    <AcceptBanner accept={acceptOrgTerms} notice={updated ? <OrgTermsUpdateNotice /> : null}>
      J&apos;accepte, au nom de <span className="text-fg">{orgName}</span>, {updated ? "la nouvelle version des " : "les "}
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
