import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { ACCESSIBILITY_UPDATED_AT, getLegalInfo } from "@/lib/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Déclaration d'accessibilité — Rydar Drive" },
  description:
    "État de conformité de Rydar Drive au RGAA (non conforme : aucun audit réalisé), contrôles effectués, limites connues, contact et voies de recours.",
};

/**
 * Déclaration d'accessibilité (modèle du RGAA). État « non conforme » tant qu'AUCUN audit RGAA n'a été réalisé : ne
 * jamais écrire « partiellement » ou « totalement conforme » sans un audit qui mesure le taux de conformité (même
 * mention dans le lien du pied de page, LEGAL_LINKS). Mettre à jour la liste des limites connues à chaque contrôle
 * (ACCESSIBILITY_UPDATED_AT).
 */
const ACCESSIBILITY_STATUS = "non conforme";

export default async function AccessibilityPage() {
  const legal = await getLegalInfo();
  const contact = legal.email ? (
    <a href={`mailto:${legal.email}`} className="text-fg underline underline-offset-2">{legal.email}</a>
  ) : (
    "l'adresse indiquée dans les mentions légales"
  );
  const link = "text-fg underline underline-offset-2";
  return (
    <LegalPage title="Déclaration d'accessibilité" updatedAt={ACCESSIBILITY_UPDATED_AT}>
      <p>
        L&apos;éditeur de Rydar Drive s&apos;engage à rendre ses services numériques accessibles, conformément à
        l&apos;article 47 de la loi n° 2005-102 du 11 février 2005. La présente déclaration s&apos;applique au site
        Rydar Drive : pages publiques, connexion, inscription des chauffeurs par lien, mini-sites de réservation et
        tableau de bord des centrales. L&apos;application mobile « Rydar Drive Chauffeur » n&apos;a pas encore été
        évaluée.
      </p>

      <LegalSection title="État de conformité">
        <p>
          Rydar Drive est <span className="text-fg">{ACCESSIBILITY_STATUS}</span> avec le référentiel général
          d&apos;amélioration de l&apos;accessibilité (RGAA), version 4.1.2 : aucun audit de conformité n&apos;a encore
          été réalisé. Aucun taux de conformité ne peut donc être annoncé.
        </p>
      </LegalSection>

      <LegalSection title="Contrôles réalisés">
        <p>
          Le {ACCESSIBILITY_UPDATED_AT}, l&apos;éditeur a contrôlé, sans valeur d&apos;audit : les règles automatiques des
          WCAG 2.0, 2.1 et 2.2 (niveaux A et AA, outil axe-core 4.13 dans le navigateur Chromium), le contraste des
          textes mesuré au pixel, la navigation complète au clavier et la visibilité du focus, l&apos;affichage à
          320 pixels de large, le texte agrandi à 200 % et le réglage « réduire les animations ». Pages contrôlées :
          accueil, fonctionnement, avantages, tarifs, questions fréquentes, contact, connexion, mot de passe oublié, pages
          légales, inscription par lien, mini-site de réservation, ainsi que les principaux écrans du tableau de bord
          et de l&apos;administration. Aucun lecteur d&apos;écran (NVDA, VoiceOver) n&apos;a encore été utilisé.
        </p>
        <p>
          Les défauts relevés ont été corrigés : libellés, aides et messages d&apos;erreur reliés aux champs, contraste
          du texte secondaire et des contours de champs, focus visible et jamais masqué par le bandeau d&apos;information
          sur les cookies, mouvements arrêtés au bout de 5 secondes (et dès le réglage « réduire les animations »),
          commande de pause de l&apos;animation du globe, titres de page et hiérarchie des titres, zones défilantes
          atteignables au clavier, liens ouvrant un nouvel onglet annoncés. Après ces corrections, l&apos;outil
          automatique ne relève plus de défaut sur les pages contrôlées (pages du site vitrine mesurées avec le réglage
          « réduire les animations », leurs fondus au défilement faussant la mesure du contraste) : cela ne suffit pas à
          établir la conformité.
        </p>
      </LegalSection>

      <LegalSection title="Limites connues">
        <LegalList
          items={[
            <>Cartes interactives (centre de commande, suivi d&apos;une course, carte des chauffeurs, mini-site) : non utilisables au lecteur d&apos;écran. Les mêmes informations sont disponibles sous forme de listes et de texte : liste des courses avec leurs adresses et leur statut, liste des chauffeurs avec leur état et l&apos;heure de leur dernière position.</>,
            <>Graphiques des statistiques : les principaux chiffres sont aussi affichés en texte, mais toutes les valeurs d&apos;un graphique ne le sont pas.</>,
            <>Bandeaux d&apos;acceptation des conditions du tableau de bord : leurs liens s&apos;ouvrent dans un nouvel onglet sans l&apos;annoncer.</>,
            <>Mini-sites de réservation : la couleur principale est choisie par chaque centrale ; le réglage signale une couleur trop sombre, sans l&apos;interdire.</>,
            <>Application mobile « Rydar Drive Chauffeur » : non évaluée.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Technologies utilisées">
        <p>HTML5, CSS, JavaScript, WAI-ARIA.</p>
      </LegalSection>

      <LegalSection title="Retour d'information et contact">
        <p>
          Si vous n&apos;arrivez pas à accéder à un contenu ou à un service, écrivez à {contact} : nous vous indiquerons
          une alternative accessible ou vous transmettrons le contenu sous une autre forme.
        </p>
      </LegalSection>

      <LegalSection title="Voies de recours">
        <p>
          Si vous avez signalé un défaut d&apos;accessibilité qui vous empêche d&apos;accéder à un contenu ou à un
          service et que vous n&apos;avez pas obtenu de réponse satisfaisante, vous pouvez :
        </p>
        <LegalList
          items={[
            <>
              écrire un message au Défenseur des droits (
              <a href="https://formulaire.defenseurdesdroits.fr/" className={link}>formulaire en ligne</a>) ;
            </>,
            <>
              contacter le délégué du Défenseur des droits de votre région (
              <a href="https://www.defenseurdesdroits.fr/carte-des-delegues" className={link}>carte des délégués</a>) ;
            </>,
            <>envoyer un courrier par la poste, gratuit, sans timbre : Défenseur des droits, Libre réponse 71120, 75342 Paris CEDEX 07.</>,
          ]}
        />
        <p>
          Voir aussi les <Link href="/mentions-legales" className={link}>mentions légales</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
