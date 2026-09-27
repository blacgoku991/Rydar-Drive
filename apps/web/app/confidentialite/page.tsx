import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { LEGAL_UPDATED_AT, legalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Politique de confidentialité — Rydar Drive" },
  description: "Données traitées par l'application chauffeur Rydar Drive, finalités, durées de conservation et droits.",
};

export default function PrivacyPage() {
  const legal = legalInfo();
  const contact = legal.email ? (
    <a href={`mailto:${legal.email}`} className="text-fg underline underline-offset-2">{legal.email}</a>
  ) : (
    "votre centrale"
  );
  return (
    <LegalPage title="Politique de confidentialité" updatedAt={LEGAL_UPDATED_AT}>
      <p>
        Rydar Drive est une plateforme de dispatch pour les centrales et flottes de VTC. L&apos;application mobile
        Rydar Drive est destinée aux chauffeurs de ces centrales : elle leur propose des courses, les guide et leur
        permet de suivre leurs gains. Cette page explique quelles données sont traitées, pourquoi, et comment exercer
        vos droits.
      </p>

      <LegalSection title="Qui traite vos données">
        <p>
          L&apos;application est éditée par <span className="text-fg">{legal.name}</span>
          {legal.address ? <>, {legal.address}</> : null}. La centrale (ou la flotte) qui vous a inscrit décide de
          l&apos;usage de vos données pour votre activité avec elle : elle en est responsable, et Rydar Drive les traite
          pour son compte. Rydar Drive est responsable des traitements liés à la sécurité de la plateforme et à la
          lutte contre la fraude.
        </p>
        <p>Contact pour vos données personnelles : {contact}.</p>
      </LegalSection>

      <LegalSection title="Données traitées">
        <LegalList
          items={[
            <>Identité et contact : prénom, nom, téléphone, e-mail, photo éventuelle.</>,
            <>Documents professionnels que vous envoyez : carte VTC, permis, pièce d&apos;identité, assurance, avec leurs dates d&apos;échéance.</>,
            <>Véhicule : marque, modèle, plaque, catégorie, nombre de places.</>,
            <>
              Position GPS : uniquement lorsque vous êtes <span className="text-fg">EN LIGNE</span> ou en course, y compris
              application en arrière-plan ou téléphone verrouillé. Hors ligne, aucune position n&apos;est collectée.
            </>,
            <>Activité : courses proposées, acceptées ou refusées, trajets, gains, commissions et règlements.</>,
            <>Messages échangés avec votre centrale et signalements (contrôles, accidents, bouchons) partagés avec la flotte.</>,
            <>Appareil : identifiant d&apos;installation, modèle, version du système et de l&apos;application, jeton de notification, niveau de batterie.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Pourquoi">
        <LegalList
          items={[
            <>Vous proposer les courses les plus proches (4 km, puis 8 km, 12 km…) et permettre à la centrale et au client de suivre l&apos;approche et la course.</>,
            <>Vous guider jusqu&apos;au client puis à la destination.</>,
            <>Calculer vos gains, les commissions et les règlements avec la centrale.</>,
            <>Vous envoyer les offres de course, messages et rappels par notification.</>,
            <>Assurer la sécurité de la plateforme, prévenir la fraude et respecter nos obligations légales et comptables.</>,
          ]}
        />
        <p>Aucune donnée n&apos;est vendue, utilisée pour de la publicité ou pour vous suivre sur d&apos;autres applications.</p>
      </LegalSection>

      <LegalSection title="Localisation en arrière-plan">
        <p>
          Quand vous êtes EN LIGNE, l&apos;application continue de partager votre position si vous changez
          d&apos;application ou verrouillez votre téléphone, pour que les courses proches continuent de vous être
          proposées. Sur Android, une notification « Rydar Drive — EN LIGNE » l&apos;indique en permanence ; sur
          iPhone, l&apos;indicateur de localisation s&apos;affiche. Passer hors ligne ou fermer l&apos;application
          arrête la collecte.
        </p>
      </LegalSection>

      <LegalSection title="Destinataires">
        <LegalList
          items={[
            <>Votre centrale (gérants et dispatchers) et, pour une course, le client concerné (approche du véhicule).</>,
            <>Nos prestataires techniques, dans la limite de leur mission : hébergement des serveurs, envoi des notifications (Apple, Google, Expo), cartographie et calcul d&apos;itinéraires.</>,
            <>Les autorités, lorsque la loi l&apos;exige.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Durées de conservation">
        <LegalList
          items={[
            <>Compte, documents et véhicule : tant que votre compte existe.</>,
            <>Historique détaillé des positions : 30 jours.</>,
            <>Messages : 180 jours.</>,
            <>Courses, gains, commissions et règlements : 10 ans (obligations comptables), sans votre identité après suppression du compte.</>,
            <>En cas de bannissement pour fraude : empreintes chiffrées (irréversibles) de vos identifiants, pour empêcher une nouvelle inscription.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Vos droits">
        <p>
          Vous pouvez accéder à vos données, les faire rectifier ou supprimer, vous opposer à un traitement, en demander
          la limitation ou la portabilité, en écrivant à {contact}. Vous pouvez aussi saisir la CNIL (cnil.fr).
        </p>
        <p>
          Pour supprimer votre compte : dans l&apos;application, <span className="text-fg">Profil › Supprimer mon compte</span>,
          ou voir la page{" "}
          <Link href="/suppression-compte" className="text-fg underline underline-offset-2">Supprimer son compte</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Sécurité">
        <p>
          Les échanges sont chiffrés (HTTPS). Sur le téléphone, la session est chiffrée et sa clé stockée dans le
          trousseau sécurisé du système. L&apos;accès aux données est limité à votre centrale et aux personnes qui en
          ont besoin.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
