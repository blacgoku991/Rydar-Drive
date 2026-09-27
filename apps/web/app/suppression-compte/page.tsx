import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { LEGAL_UPDATED_AT, legalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Supprimer son compte — Rydar Drive" },
  description: "Comment supprimer votre compte chauffeur Rydar Drive et ce qui est supprimé.",
};

export default function AccountDeletionPage() {
  const legal = legalInfo();
  return (
    <LegalPage title="Supprimer son compte chauffeur" updatedAt={LEGAL_UPDATED_AT}>
      <LegalSection title="Depuis l'application">
        <LegalList
          items={[
            <>Ouvrez Rydar Drive et connectez-vous.</>,
            <>Allez dans <span className="text-fg">Profil</span>, puis <span className="text-fg">Supprimer mon compte</span>.</>,
            <>Confirmez. La suppression est immédiate et définitive.</>,
          ]}
        />
        <p>
          Si une course vous est attribuée, terminez-la ou demandez à votre centrale de la réattribuer, puis supprimez
          votre compte.
        </p>
      </LegalSection>

      <LegalSection title="Sans l'application">
        <p>
          Écrivez{" "}
          {legal.email ? (
            <>
              à <a href={`mailto:${legal.email}`} className="text-fg underline underline-offset-2">{legal.email}</a>
            </>
          ) : (
            "à votre centrale"
          )}{" "}
          depuis l&apos;adresse e-mail de votre compte, avec l&apos;objet « Suppression de compte ». La suppression est
          effectuée sous 30 jours au plus et vous est confirmée par e-mail.
        </p>
      </LegalSection>

      <LegalSection title="Ce qui est supprimé">
        <LegalList
          items={[
            <>Votre compte de connexion, votre nom, téléphone, e-mail et photo.</>,
            <>Vos documents (carte VTC, permis, pièce d&apos;identité…) et leurs fichiers.</>,
            <>Vos positions et leur historique, vos appareils et jetons de notification.</>,
            <>Vos messages avec la centrale et vos signalements.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Ce qui est conservé, sans votre identité">
        <p>
          Les courses réalisées, gains, commissions et règlements sont conservés 10 ans pour les obligations comptables
          de la centrale, rattachés à une fiche anonyme (« Chauffeur supprimé »). En cas de bannissement pour fraude, des
          empreintes chiffrées et irréversibles de vos identifiants sont conservées pour empêcher une nouvelle inscription.
        </p>
        <p>
          Plus de détails : <Link href="/confidentialite" className="text-fg underline underline-offset-2">politique de confidentialité</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
