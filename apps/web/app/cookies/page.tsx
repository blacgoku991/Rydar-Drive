import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { COOKIES_UPDATED_AT, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Cookies — Rydar Drive" },
  description: "Cookies et stockage local utilisés par Rydar Drive : uniquement ce qui est nécessaire au service, aucun traceur publicitaire ni de mesure d'audience.",
};

type Line = { name: string; role: string; duration: string };

/**
 * Tableau « nom / rôle / durée » (défile horizontalement sur petit écran ; zone défilante atteignable au clavier et
 * nommée).
 */
function StorageTable({ lines, label }: { lines: Line[]; label: string }) {
  return (
    <div className="overflow-x-auto rounded-md" tabIndex={0} role="region" aria-label={label}>
      <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-line-strong text-fg">
            <th scope="col" className="py-2 pr-4 font-medium">Nom</th>
            <th scope="col" className="py-2 pr-4 font-medium">Rôle</th>
            <th scope="col" className="py-2 font-medium">Durée</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.name} className="border-b border-line align-top">
              <td className="py-2 pr-4 font-mono text-[12px] text-fg">{l.name}</td>
              <td className="py-2 pr-4">{l.role}</td>
              <td className="py-2">{l.duration}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const COOKIES: Line[] = [
  {
    name: "sb-…-auth-token",
    role: "Session de connexion au tableau de bord (Supabase). Peut être découpé en plusieurs cookies (.0, .1…) si la session est longue.",
    duration: "Jusqu'à la déconnexion (400 jours au plus, renouvelé à l'usage)",
  },
  {
    name: "sb-…-auth-token-code-verifier",
    role: "Sécurise le lien de réinitialisation du mot de passe (échange de code PKCE).",
    duration: "Jusqu'à l'utilisation du lien",
  },
  {
    name: "rd_org",
    role: "Centrale sélectionnée dans le tableau de bord, pour un compte qui en gère plusieurs. Illisible par les scripts (httpOnly).",
    duration: "Jusqu'à la fermeture du navigateur",
  },
];

const STORAGE: Line[] = [
  { name: "rydar.sound", role: "Son des alertes du tableau de bord activé ou coupé (stockage local).", duration: "Jusqu'à effacement" },
  { name: "rydar.mapTheme, rydar.mapReports", role: "Préférences du centre de commande : carte jour ou nuit, affichage des signalements (stockage local).", duration: "Jusqu'à effacement" },
  { name: "rydar.alerts:…", role: "Alertes récentes du centre de commande, pour les retrouver après un rechargement (stockage de session).", duration: "Jusqu'à la fermeture de l'onglet" },
  { name: "rydar.platform-banner:…", role: "Bandeau des frais plateforme masqué (stockage de session).", duration: "Jusqu'à la fermeture de l'onglet" },
  {
    name: "rd_org_switch",
    role: "Changement de centrale annoncé aux autres onglets ouverts du tableau de bord, quand le navigateur n'offre pas de canal entre onglets (stockage local, identifiant de la centrale et heure du changement).",
    duration: "Jusqu'à effacement (remplacé au changement suivant)",
  },
  { name: "rd_cookie_notice", role: "Bandeau d'information sur les cookies fermé (stockage local).", duration: "Jusqu'à effacement" },
];

export default async function CookiesPage() {
  const legal = await getLegalInfo();
  const contact = legal.privacyEmail ? (
    <a href={`mailto:${legal.privacyEmail}`} className="text-fg underline underline-offset-2">{legal.privacyEmail}</a>
  ) : (
    "l'adresse indiquée dans les mentions légales"
  );
  return (
    <LegalPage title="Cookies et stockage local" updatedAt={COOKIES_UPDATED_AT}>
      <p>
        Rydar Drive n&apos;utilise <span className="text-fg">aucun cookie de mesure d&apos;audience, de publicité ou de
        réseau social</span>, et aucun traceur d&apos;un tiers. Les seuls cookies et données stockés dans votre
        navigateur sont strictement nécessaires au service que vous demandez : ils sont exemptés de consentement
        (article 82 de la loi Informatique et Libertés, lignes directrices de la CNIL du 17 septembre 2020). C&apos;est
        pourquoi le site affiche une simple information, sans demande de consentement.
      </p>

      <LegalSection title="Cookies">
        <p>Déposés uniquement si vous vous connectez au tableau de bord ou demandez un nouveau mot de passe :</p>
        <StorageTable lines={COOKIES} label="Cookies déposés" />
        <p>
          Réserver une course sur un mini-site, consulter l&apos;accueil ou les pages légales ne dépose aucun cookie.
        </p>
      </LegalSection>

      <LegalSection title="Stockage local du navigateur">
        <p>
          Quelques préférences restent dans votre navigateur. Elles ne sont jamais envoyées à nos serveurs et ne servent
          pas à vous suivre :
        </p>
        <StorageTable lines={STORAGE} label="Données stockées dans le navigateur" />
      </LegalSection>

      <LegalSection title="Services tiers">
        <LegalList
          items={[
            <>Paiement de l&apos;abonnement d&apos;une centrale : la page de paiement est hébergée par Stripe, qui y dépose ses propres cookies (sécurité, prévention de la fraude), régis par sa politique.</>,
            <>Cartes : les images de carte sont chargées sans cookie depuis le serveur de tuiles (OpenFreeMap par défaut), qui reçoit comme tout serveur web l&apos;adresse IP de votre navigateur.</>,
            <>Application chauffeur : elle n&apos;utilise pas de cookie. Sa session est chiffrée sur le téléphone, avec une clé gardée dans le trousseau sécurisé du système.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Pourquoi aucun bouton « Tout accepter » ou « Tout refuser »">
        <p>
          Tous les cookies et données ci-dessus sont strictement nécessaires : aucun ne demande votre consentement, il
          n&apos;y a donc rien à accepter ni à refuser. Le bandeau d&apos;information se ferme d&apos;un clic ; il revient
          si vous effacez les données du site. Cette page reste accessible à tout moment par le lien « Cookies » en bas
          de chaque page.
        </p>
        <p>
          Si l&apos;éditeur ajoutait un jour un traceur soumis à consentement (mesure d&apos;audience non exemptée,
          publicité, réseau social, vidéo intégrée), aucun ne serait déposé avant votre choix : une fenêtre vous
          proposerait « Tout refuser » aussi simplement que « Tout accepter », votre choix serait gardé 6 mois au plus et
          modifiable à tout moment depuis le lien « Cookies », et cette page serait mise à jour avant.
        </p>
      </LegalSection>

      <LegalSection title="Les supprimer">
        <p>
          Vous pouvez effacer les cookies et les données du site dans les réglages de votre navigateur (rubrique
          confidentialité ou données de site). Supprimer le cookie de session vous déconnecte ; supprimer les
          préférences les remet à leur valeur par défaut. Le service reste utilisable.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Pour toute question : {contact}. Voir aussi la{" "}
          <Link href="/confidentialite" className="text-fg underline underline-offset-2">politique de confidentialité</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
