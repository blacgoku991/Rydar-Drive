"use client";
// Acceptation des conditions (version en vigueur). Un seul bandeau à la fois (dashboard/layout.tsx, choix :
// terms-state.ts) :
//  - TermsBanner (owner / admin) : CGV + accord de traitement des données (art. 28 RGPD) au nom de la centrale
//    (ORG_LEGAL_VERSION), et à titre personnel CGU + politique de confidentialité (LEGAL_VERSION) ; mode « mise à
//    jour » quand l'organisation avait accepté une version antérieure des CGV (principaux changements, date d'entrée en
//    vigueur au plus tard tant qu'elle n'est pas passée) ; non bloquant : le dispatch continue ;
//  - OrgTermsGate (owner / admin d'une organisation qui n'a JAMAIS accepté les CGV et n'a encore aucune course) : même
//    acceptation, en écran plein, avant la première course (des CGV non acceptées ne sont pas opposables) ;
//  - UserTermsBanner (tout membre, dispatcher compris) : CGU + politique de confidentialité à titre personnel.
import { ORG_LEGAL_CHANGES, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, legalDateLabel } from "@rydar/shared";
import { FileCheck2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { acceptOrgTerms, acceptUserTerms } from "@/app/dashboard/actions";
import { fr } from "@/components/marketing/typo";
import { Button } from "@/components/ui/button";
import { runAction } from "@/lib/run-action";
import { cn } from "@/lib/utils";

const link = "text-fg underline underline-offset-2";

/**
 * Case à cocher + « Accepter » : enregistre l'acceptation puis relit la mise en page. `notice` : texte au-dessus ;
 * `card` : présentation en carte (écran d'acceptation avant la première course) au lieu du bandeau.
 */
function AcceptBanner({
  accept,
  notice,
  card = false,
  children,
}: {
  accept: () => Promise<{ ok: true } | { ok: false; error: string }>;
  notice?: React.ReactNode;
  card?: boolean;
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
    <div
      role="region"
      aria-label="Conditions à accepter"
      className={card ? "rounded-2xl border border-line bg-blue/[0.05] p-5 sm:p-6" : "border-b border-line bg-blue/[0.06] px-4 py-3 sm:px-6"}
    >
      <div className={cn("flex flex-col gap-3", !card && "lg:flex-row lg:items-center")}>
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <FileCheck2 className="mt-0.5 size-5 shrink-0 text-blue" />
          <div className="min-w-0 space-y-2">
            {notice ? <div className="space-y-1.5 text-[13px] leading-relaxed text-fg-muted">{notice}</div> : null}
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-fg-muted">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]" />
              <span>{children}</span>
            </label>
          </div>
        </div>
        <Button variant="primary" size="sm" loading={pending} disabled={!checked} onClick={submit} className={card ? "self-end" : "self-end lg:self-auto"}>
          Accepter
        </Button>
      </div>
    </div>
  );
}

/**
 * Principaux changements de la version ORG_LEGAL_VERSION des CGV (ORG_LEGAL_CHANGES : même liste que le préambule des
 * CGV et l'e-mail d'annonce) et sa date d'entrée en vigueur pour une organisation qui avait accepté une version
 * antérieure : « au plus tard le … ; vous pouvez résilier sans frais avant » tant que cette date n'est pas passée,
 * puis « en vigueur depuis le … » (le droit de résilier sans frais avant cette date n'existe plus).
 */
function OrgTermsUpdateNotice({ effectivePassed }: { effectivePassed: boolean }) {
  const effective = legalDateLabel(ORG_LEGAL_EFFECTIVE_AT);
  return (
    <>
      <p>
        <span className="font-medium text-fg">
          Nouvelles conditions générales de vente (version du {legalDateLabel(ORG_LEGAL_VERSION)})&nbsp;:
        </span>{" "}
        principaux changements.
      </p>
      <ul className="list-disc space-y-1 pl-5 marker:text-fg-subtle">
        {ORG_LEGAL_CHANGES.map((c) => (
          <li key={c}>{fr(c)}</li>
        ))}
      </ul>
      <p>
        {effectivePassed ? (
          <>Pour votre organisation, elles sont en vigueur depuis le {effective}.</>
        ) : (
          <>
            Pour votre organisation, elles s&apos;appliquent dès votre acceptation, et au plus tard le {effective}&nbsp;; vous pouvez
            résilier sans frais ni préavis avant cette date, avec remboursement au prorata de l&apos;abonnement payé d&apos;avance.
          </>
        )}{" "}
        <a href="/cgv#changements" target="_blank" rel="noopener" className={link}>
          Lire les nouvelles CGV
        </a>
      </p>
    </>
  );
}

/** Texte d'acceptation au nom de l'organisation (CGV, accord de traitement) et à titre personnel (CGU, politique). */
function OrgAcceptText({ orgName, updated }: { orgName: string; updated: boolean }) {
  return (
    <>
      J&apos;accepte, au nom de <span className="text-fg">{orgName}</span>, {updated ? "la nouvelle version des " : "les "}
      <a href="/cgv" target="_blank" rel="noopener" className={link}>conditions générales de vente</a> et l&apos;
      <a href="/dpa" target="_blank" rel="noopener" className={link}>accord de traitement des données (RGPD)</a>, ainsi que les{" "}
      <a href="/cgu" target="_blank" rel="noopener" className={link}>conditions d&apos;utilisation</a> et la{" "}
      <a href="/confidentialite" target="_blank" rel="noopener" className={link}>politique de confidentialité</a>. Je confirme que la
      centrale respecte ses obligations de transporteur (inscription VTC, déclaration de centrale de réservation le cas échéant).
    </>
  );
}

/**
 * Owner / admin : conditions de la centrale (et, pour lui-même, CGU + politique de confidentialité). `updated` :
 * l'organisation avait accepté une version antérieure des CGV (mise à jour à accepter) ; `effectivePassed` : la date
 * d'entrée en vigueur au plus tard (ORG_LEGAL_EFFECTIVE_AT, heure de Paris) est atteinte.
 */
export function TermsBanner({ orgName, updated = false, effectivePassed = false }: { orgName: string; updated?: boolean; effectivePassed?: boolean }) {
  return (
    <AcceptBanner accept={acceptOrgTerms} notice={updated ? <OrgTermsUpdateNotice effectivePassed={effectivePassed} /> : null}>
      <OrgAcceptText orgName={orgName} updated={updated} />
    </AcceptBanner>
  );
}

/**
 * Owner / admin d'une organisation qui n'a jamais accepté les CGV et n'a encore aucune course : acceptation avant la
 * première course (les frais par course éventuels s'appliquent dès l'ouverture du compte : CGV art. 5).
 */
export function OrgTermsGate({ orgName }: { orgName: string }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-[20px] font-semibold tracking-tight text-fg">Conditions à accepter avant votre première course</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-fg-muted">
        Avant de créer des courses, le propriétaire ou un administrateur accepte, au nom de <span className="text-fg">{orgName}</span>,
        les conditions générales de vente (abonnement, frais plateforme par course, paiement, résiliation) et l&apos;accord de
        traitement des données. Elles s&apos;appliquent à votre organisation dès cette acceptation.
      </p>
      <div className="mt-6">
        <AcceptBanner accept={acceptOrgTerms} card>
          <OrgAcceptText orgName={orgName} updated={false} />
        </AcceptBanner>
      </div>
    </div>
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
