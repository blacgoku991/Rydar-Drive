import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { NOTICE_UPDATED_AT, getLegalInfo } from "@/lib/legal";
import { capitalRequired } from "@/lib/legal-notice";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Mentions légales — Rydar Drive" },
  description:
    "Éditeur, hébergement, point de contact, propriété intellectuelle, signalement de contenu illicite et crédits du service Rydar Drive.",
};

/** Valeur renseignée, ou mention visible « à compléter par l'éditeur ». */
function Value({ children }: { children: string }) {
  if (!children) return <span className="text-amber">à compléter par l&apos;éditeur</span>;
  return <span className="text-fg">{children}</span>;
}

/** Ligne « libellé : valeur » des blocs d'identification. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      {label} : <Value>{value}</Value>
    </>
  );
}

export default async function LegalNoticePage() {
  const legal = await getLegalInfo();
  // Raison sociale non renseignée (ni /admin/legal ni LEGAL_NAME) : « à compléter », pas le nom du service
  const companyName = legal.nameSet ? legal.name : "";
  // Capital social : exigé d'une société, sans objet pour une entreprise individuelle (EI, micro-entreprise)
  const showCapital = !!legal.capital || capitalRequired(legal.form);
  const email = legal.email ? (
    <a href={`mailto:${legal.email}`} className="text-fg underline underline-offset-2">{legal.email}</a>
  ) : (
    <Value>{""}</Value>
  );
  return (
    <LegalPage title="Mentions légales" updatedAt={NOTICE_UPDATED_AT}>
      <p>
        Informations publiées en application de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans
        l&apos;économie numérique (LCEN, article 1-1). Elles concernent le site Rydar Drive, ses sous-domaines, le tableau de bord
        des centrales, l&apos;API, les mini-sites de réservation qu&apos;il héberge et l&apos;application mobile
        « Rydar Drive Chauffeur ».
      </p>

      <LegalSection title="Éditeur">
        <LegalList
          items={[
            <Row label="Raison sociale" value={companyName} />,
            <Row label="Forme juridique" value={legal.form} />,
            ...(showCapital ? [<Row label="Capital social" value={legal.capital} />] : []),
            <Row label="Siège social" value={legal.address} />,
            <Row label="Immatriculation (RCS ou SIREN)" value={legal.registration} />,
            <Row label="N° de TVA intracommunautaire" value={legal.vat} />,
            <Row label="Directeur de la publication" value={legal.director} />,
            <>E-mail : {email}</>,
            <Row label="Téléphone" value={legal.phone} />,
          ]}
        />
        <p>
          L&apos;éditeur conçoit et exploite un logiciel de dispatch pour les centrales et flottes de VTC. Il n&apos;est
          ni transporteur, ni exploitant de VTC, ni centrale de réservation, ni intermédiaire de paiement : les courses,
          les clients, les prix et les chauffeurs relèvent de chaque centrale. Voir les{" "}
          <Link href="/cgu" className="text-fg underline underline-offset-2">conditions générales d&apos;utilisation</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Point de contact">
        <p>
          Point de contact unique de l&apos;éditeur pour les autorités des États membres, la Commission européenne et
          les utilisateurs du service (règlement (UE) 2022/2065 sur les services numériques, articles 11 et 12) :{" "}
          {email}. Langue acceptée : français.
        </p>
      </LegalSection>

      <LegalSection title="Hébergeur du site">
        <p>Serveur qui héberge le site, l&apos;API et les traitements automatiques (dispatch, notifications, e-mails) :</p>
        <LegalList
          items={[
            <Row label="Hébergeur" value={legal.hostName} />,
            <Row label="Adresse" value={legal.hostAddress} />,
            <Row label="Téléphone" value={legal.hostPhone} />,
          ]}
        />
      </LegalSection>

      <LegalSection title="Hébergement des données">
        <p>
          Base de données, comptes de connexion, fichiers et sauvegardes : <Value>{legal.dataHost}</Value>. La liste
          complète des prestataires techniques figure dans l&apos;
          <Link href="/dpa" className="text-fg underline underline-offset-2">accord de traitement des données</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Mini-sites de réservation">
        <p>
          Chaque mini-site de réservation (sous-domaine ou domaine propre) est publié par la centrale qui y est nommée.
          Elle est l&apos;exploitant du service de transport et répond du contenu du mini-site (textes, photos, prix,
          conditions). Son nom figure en bas du mini-site, avec son numéro SIRET et son inscription au registre des VTC
          lorsqu&apos;elle les a renseignés. L&apos;éditeur ne fournit que le logiciel.
        </p>
      </LegalSection>

      <LegalSection title="Propriété intellectuelle">
        <p>
          Le logiciel, les applications, la marque et le logo Rydar Drive, les textes, la charte graphique et les bases
          de données de l&apos;éditeur sont protégés par le Code de la propriété intellectuelle. Toute reproduction,
          adaptation ou extraction sans autorisation écrite de l&apos;éditeur est interdite, sous réserve des
          exceptions prévues par la loi. Les logos, photos et textes publiés par une centrale sur son mini-site restent
          sa propriété.
        </p>
      </LegalSection>

      <LegalSection title="Signaler un contenu illicite">
        <p>
          Pour signaler un contenu illicite hébergé par le service (message, signalement de la flotte, texte ou image
          d&apos;un mini-site), écrivez à {email} en indiquant : la date, l&apos;adresse de la page ou l&apos;écran
          concerné, la description du contenu, les raisons pour lesquelles vous le jugez illicite et vos coordonnées.
        </p>
        <p>
          Dans l&apos;application, un chauffeur peut aussi signaler un message ou masquer les messages de son auteur par
          un appui long : ce signalement est adressé à la centrale, qui modère son fil. Pour un contenu illicite, ou si
          la centrale ne réagit pas, écrivez à l&apos;éditeur à l&apos;adresse ci-dessus.
        </p>
        <p>
          L&apos;éditeur examine les signalements qu&apos;il reçoit, retire le contenu manifestement illicite ou demande à
          la centrale concernée de le faire, et informe l&apos;auteur du signalement de la suite donnée, conformément au
          règlement (UE) 2022/2065 sur les services numériques. Un signalement abusif peut engager la responsabilité de
          son auteur.
        </p>
      </LegalSection>

      <LegalSection title="Données personnelles, cookies et accessibilité">
        <p>
          Voir la{" "}
          <Link href="/confidentialite" className="text-fg underline underline-offset-2">politique de confidentialité</Link>, la{" "}
          <Link href="/cookies" className="text-fg underline underline-offset-2">politique cookies</Link>, l&apos;
          <Link href="/dpa" className="text-fg underline underline-offset-2">accord de traitement des données</Link> et la{" "}
          <Link href="/accessibilite" className="text-fg underline underline-offset-2">déclaration d&apos;accessibilité</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Crédits">
        <LegalList
          items={[
            <>Cartes du site : © OpenStreetMap contributors (licence ODbL), schéma et style OpenMapTiles, tuiles servies par OpenFreeMap.</>,
            <>Cartes de l&apos;application : Plans d&apos;Apple sur iPhone, Google Maps sur Android.</>,
            <>Adresses : Géoplateforme de l&apos;IGN et Base Adresse Nationale (Licence Ouverte Etalab 2.0).</>,
            <>Itinéraires : OSRM (Open Source Routing Machine), à partir des données OpenStreetMap.</>,
            <>Polices Geist et Geist Mono (SIL Open Font License), icônes Lucide (licence ISC).</>,
          ]}
        />
      </LegalSection>
    </LegalPage>
  );
}
