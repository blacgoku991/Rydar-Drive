import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { LEGAL_UPDATED_AT, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Supprimer son compte — Rydar Drive" },
  description: "Comment supprimer votre compte chauffeur Rydar Drive, ce qui est supprimé, ce qui est conservé et pendant combien de temps.",
};

const strong = "text-fg";
const link = "text-fg underline underline-offset-2";

/**
 * Suppression du compte chauffeur (lien déclaré à Google Play et à l'App Store). Décrit EXACTEMENT le traitement
 * de private.delete_driver_account (migration 20260924004000, avec le déclencheur drivers_chat_forget_deleted de
 * 20260924004100), de la route /api/driver/delete-account, de la file private.account_deletions (reprise par le
 * worker) et de l'outil super admin /admin/suppressions. Durées : private.housekeeping (20260924003900),
 * private.purge_expired_bans et private.purge_deleted_driver_bans.
 */
export default async function AccountDeletionPage() {
  const legal = await getLegalInfo();
  const contact = legal.privacyEmail;
  return (
    <LegalPage title="Supprimer son compte chauffeur" updatedAt={LEGAL_UPDATED_AT}>
      <p>
        Cette page concerne l&apos;application <span className={strong}>Rydar Drive</span> destinée aux chauffeurs, éditée par{" "}
        <span className={strong}>{legal.name}</span>
        {legal.address ? ` (${legal.address})` : ""}. Rydar Drive est un logiciel de dispatch utilisé par votre centrale : les
        courses, les clients, les prix et les règlements appartiennent à la centrale, qui vous confie les courses.
      </p>

      <LegalSection title="Depuis l'application">
        <LegalList
          items={[
            <>Ouvrez Rydar Drive et connectez-vous.</>,
            <>
              Allez dans <span className={strong}>Profil</span>, puis <span className={strong}>Supprimer mon compte</span>. Le même
              bouton figure sur l&apos;écran d&apos;un compte en attente de validation, refusé, suspendu, banni ou dont la centrale
              est suspendue. Si la connexion vous est refusée (compte refusé, suspendu ou banni, centrale suspendue),
              l&apos;écran de connexion propose aussi « Supprimer mon compte ».
            </>,
            <>
              Si votre session n&apos;est plus valable (session expirée, compte suspendu ou banni, centrale suspendue),
              confirmez avec l&apos;e-mail et le mot de passe de votre compte.
            </>,
            <>Confirmez. La suppression est définitive.</>,
          ]}
        />
        <p>
          Dès la confirmation, vos données sont effacées ou anonymisées, puis vos fichiers et votre compte de connexion
          sont supprimés. Si cette dernière étape ne peut pas se terminer tout de suite, l&apos;application affiche
          « Suppression en cours » : le serveur la termine automatiquement, sans action de votre part (en cas d&apos;échec
          répété, l&apos;éditeur est alerté). L&apos;application n&apos;annonce « compte supprimé » qu&apos;une fois tout
          terminé.
        </p>
        <p>
          Si une course vous est attribuée, la suppression est refusée : terminez-la ou demandez à votre centrale de la
          réattribuer, puis supprimez votre compte.
        </p>
      </LegalSection>

      <LegalSection title="Sans l'application">
        {contact ? (
          <p>
            Écrivez à{" "}
            <a href={`mailto:${contact}?subject=${encodeURIComponent("Suppression de compte")}`} className={link}>
              {contact}
            </a>{" "}
            depuis l&apos;adresse e-mail de votre compte, avec l&apos;objet « Suppression de compte ». Sans accès à cette adresse,
            indiquez le numéro de téléphone enregistré et le nom de votre centrale : l&apos;éditeur vérifie alors votre
            identité, par exemple auprès de la centrale, avant d&apos;agir. La suppression est effectuée sous 30 jours au plus,
            selon le même traitement que depuis l&apos;application, et vous est confirmée par e-mail.
          </p>
        ) : (
          <>
            <p>
              Contactez votre centrale : elle transmet votre demande à l&apos;éditeur, qui effectue la suppression sous 30 jours
              au plus, selon le même traitement que depuis l&apos;application, et vous la confirme par e-mail.
            </p>
            <p className="text-amber">Adresse de contact « données personnelles » à compléter par l&apos;éditeur.</p>
          </>
        )}
        <p>Là aussi, une course qui vous est attribuée doit d&apos;abord être terminée ou réattribuée par la centrale.</p>
      </LegalSection>

      <LegalSection title="Ce qui est supprimé">
        <LegalList
          items={[
            <>
              Votre compte de connexion (e-mail, mot de passe, nom et téléphone associés). S&apos;il sert aussi à gérer une
              centrale, seul votre profil chauffeur est supprimé et votre accès au tableau de bord est conservé.
            </>,
            <>
              Sur votre fiche : votre nom, votre téléphone, votre e-mail, votre photo, votre numéro de carte VTC, votre message
              de candidature et les notes de la centrale.
            </>,
            <>
              Vos justificatifs (carte VTC, permis, pièce d&apos;identité, assurance…) et tous leurs fichiers, y compris les
              versions remplacées.
            </>,
            <>Vos positions et leur historique, vos appareils, vos jetons de notification et vos notifications.</>,
            <>
              Vos messages avec la centrale (dans les deux sens) et dans le fil « Chauffeurs », vos signalements pour la flotte
              (leur copie dans le journal de la centrale et les alertes envoyées aux autres chauffeurs comprises), vos votes,
              vos signalements de messages, les auteurs que vous aviez masqués et vos accusés de lecture.
            </>,
            <>
              Le véhicule enregistré lors de votre inscription par lien, s&apos;il n&apos;a servi à aucune course ; sinon sa plaque,
              sa marque, son modèle, sa couleur et son année sont effacés.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Ce qui est conservé, sans votre nom ni vos coordonnées">
        <LegalList
          items={[
            <>
              Les courses réalisées et leur répartition (gains, commission, frais), ainsi que les règlements : jusqu&apos;à
              10 ans après la fin de l&apos;année de chaque course, pour les obligations comptables de la centrale, puis
              supprimés. Ils sont rattachés à une fiche anonyme « Chauffeur supprimé (#N) », N étant votre numéro dans la
              centrale.
            </>,
            <>
              Dans l&apos;historique des courses, les alertes (dont la position est retirée), les règlements et le journal
              d&apos;audit, votre nom est remplacé par cette mention ou retiré, et vos coordonnées sont retirées. L&apos;adresse
              IP et le navigateur enregistrés lors de votre inscription ou de vos actions de chauffeur sont effacés du journal
              d&apos;audit dès la suppression.
            </>,
            <>
              Le commentaire et le motif d&apos;annulation d&apos;une course, saisis par la centrale ou par le client,
              appartiennent à la centrale : votre nom complet y est remplacé, le reste est conservé.
            </>,
            <>
              Les messages écrits par d&apos;autres personnes (dans le fil « Chauffeurs », par exemple) ne sont pas modifiés :
              comme tous les messages, ils sont effacés au bout de 180 jours.
            </>,
            <>
              La preuve de votre acceptation des CGU et de la politique de confidentialité (document, version, date et, le
              cas échéant, centrale) reste, détachée de votre compte de connexion supprimé.
            </>,
          ]}
        />
        <p>
          Si vous avez été banni pour fraude, des empreintes de vos identifiants (téléphone, e-mail, carte VTC, permis, pièce
          d&apos;identité, appareil, plaque le cas échéant) sont conservées, avec le motif du bannissement et, s&apos;il existe,
          le signalement de fraude, sans votre nom. Elles servent uniquement à reconnaître une nouvelle inscription avec les
          mêmes identifiants. Ce sont des hachages sha256 : ils ne sont pas chiffrés, mais ne font pas apparaître la valeur
          en clair (données pseudonymisées). Les indices partiels qui les accompagnaient (par exemple +33••••••78) sont
          effacés dès la suppression. Seuls les administrateurs de la centrale concernée et l&apos;éditeur y ont accès. Le
          tout est effacé automatiquement 3 ans après le bannissement.
        </p>
        <p>
          Plus de détails :{" "}
          <Link href="/confidentialite" className={link}>
            politique de confidentialité
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
