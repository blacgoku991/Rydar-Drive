# Refonte des panneaux — super admin et espaces clients

> **Statut : livrée et recettée** — lots R1 à R11 faits les 10 et 11/10/2026 (commits au § 8.1, écarts au § 8.2) ;
> contrôle final et recette sur la pile locale (R11) : compte rendu, mesures avant / après et captures dans
> `docs/EN-COURS.md`. Plan rédigé le 10/10/2026 sur `claude/confident-clarke-rpfwmo` (HEAD `6f5f0e6`) à partir de cinq
> audits (super admin ; cœur du tableau de bord ; argent et réseau ; réglages ; coquille et système de design) et de
> 705 captures « avant » (5 profils : super admin, propriétaire de flotte, propriétaire de centrale, dispatcher, Flotte
> Privée ; 1440×900 et 390×844 ; hors dépôt, `scratchpad/refonte/avant/`). Les références de fichiers ont été
> revérifiées dans le dépôt. Ce document est la référence de la refonte : là où le code livré diverge du plan, le code
> fait foi et l'écart est noté au § 8.2.
>
> Objectif du propriétaire : « amélioration complète de tout le panel super admin et des clients qui ont souscrit, que
> tout soit bien épuré, facile d'utilisation, compréhensible ». Public : gérants de flottes et de centrales VTC,
> chauffeurs solo Flotte Privée (non techniciens) et le super admin (le propriétaire).

## Sommaire

0. En bref
1. Périmètre et garde-fous
2. Principes
3. Règles de design communes
4. Lexique
5. Décisions par zone
6. Propositions écartées, modifiées ou reportées
7. Décisions qui reviennent au propriétaire
8. Lots
9. Recette, captures et mesures
10. Tutoriel de première connexion (phase suivante, hors refonte)
- Annexes : A. mesures avant et cibles ; B. tests du dépôt touchés ; C. sélecteurs des scripts de recette touchés

---

## 0. En bref

- La refonte ne change que l'**interface web** (`apps/web`, plus quatre tables de libellés de `@rydar/shared` lues par
  le web seul). **Aucune migration, aucune RPC modifiée, aucune garde serveur retirée, aucun calcul changé, rien dans
  l'app chauffeur.**
- Cinq défauts communs relevés par les audits : (1) menus tronqués (entrées cachées sous le bandeau cookies et les liens
  légaux) et vocabulaire qui change d'une page à l'autre ; (2) tout au même niveau : chiffres, réglages rares, technique
  et tâches du jour ; (3) tableaux et grilles fixes cassés sur téléphone ; (4) codes bruts et jargon de développeur
  (`tenant`, `failed`, `WRN`, « Option 1 ») ; (5) actions qui coupent un accès en un clic, ou mises en avant alors
  qu'elles sont rares ou impossibles.
- Réponses : une coquille qui montre tout le menu ; un bloc « À traiter » en tête des accueils ; quatre chiffres au
  plus ; réglages rares et détails techniques repliés ; listes en cartes sous 768 px ; un seul mot par chose (§ 4) ;
  une confirmation qui dit la conséquence avant toute coupure d'accès.
- **11 lots séquentiels** : R1 coquille et composants communs ; R2 à R6 super admin ; R7 à R10 espaces clients ; R11
  contrôle final, recette et documentation.
- Le **tutoriel de première connexion** est la phase suivante (§ 10) : la refonte lui laisse un vocabulaire stable,
  des blocs « À traiter » et des ancres de section.

---

## 1. Périmètre et garde-fous

### 1.1 Dans le périmètre

- `apps/web/app/admin/**`, `apps/web/app/dashboard/**`, les composants des espaces connectés (`apps/web/components/**`
  hors `marketing/`, `eligibility/` et pages publiques), des aides d'affichage dans `apps/web/lib/`, des `@utility` dans
  `apps/web/app/globals.css`.
- `packages/shared/src` : libellés **lus par le web seulement** (vérifié par recherche dans `apps/driver` et
  `apps/worker`) : `RIDE_FILTERS` (libellés), `RIDE_SOURCE_LABELS`, `RIDE_TYPE_LABELS`, `API_SCOPE_LABELS` ; et
  `platformDueSummary` (format de date mis en cache, même sortie).
- Documentation : ce document, `docs/FLOTTE-PRIVEE.md` (§ 7.3, textes de l'espace Flotte Privée), `docs/EN-COURS.md`.

### 1.2 Hors périmètre

- SQL et migrations : aucune. Si un lot découvre une nécessité absolue, il s'arrête et la signale au propriétaire ; il
  ne l'écrit jamais.
- Worker, app chauffeur (`apps/driver`), site vitrine, pages légales publiques, mini-sites publics (`/book`), pages
  `/rejoindre`, page d'éligibilité.
- Textes juridiques (CGU, CGV, DPA, confidentialité, conventions du réseau partagé), modèles WhatsApp, e-mails, messages
  écrits en base (chronologies des courses, messages d'erreur SQL, libellés d'audit stockés).
- `CLAUDE.md` : la refonte n'en a pas besoin ; toute ligne à changer revient au propriétaire (§ 7).
- Le tutoriel de première connexion (§ 10).

### 1.3 Garde-fous (ne bougent jamais)

1. **Serveur** : actions serveur, RPC et routes API gardent leurs appels, paramètres et contrôles (`requireSuperAdmin`,
   `requireOrg`, rôles, `refuseInPrivateFleet`, `privateFleetPage`, revérifications en base). Seuls ajouts permis : un
   `revalidatePath` vers une page déplacée ; un champ `fieldErrors` dans un retour déjà en échec ; une lecture en
   lecture seule pour afficher un résumé (même client Supabase, même RLS).
2. **Confirmations et preuves** : dialogues de confirmation, notes d'accord, motifs obligatoires, délais (hausse de frais
   ≥ 30 jours, etc.), cases à cocher du bannissement : jamais retirés ni contournés. Une action qui coupe un accès peut
   gagner une confirmation, jamais en perdre une.
3. **Noms cités par les CGV, les messages SQL et le modèle WhatsApp approuvé** : menus « Encaissements » (centrale),
   « Frais Rydar » (flotte), « Réseau partagé », « Mini-site » ; « frais plateforme » reste le terme des textes
   juridiques. La carte des frais Rydar reste sur Encaissements et y montre, **sans rien déplier** : taux, hausse
   annoncée et sa date d'effet, solde, échéance et lien vers le relevé (CGV art. 5, `cgv-pages.test.ts`).
4. **App chauffeur** : `SETTLEMENT_STATUS_META` et `SETTLEMENT_METHOD_META` (`packages/shared/src/centrale.ts`) sont lus
   par l'app : jamais modifiés ; un libellé web différent est une surcharge côté web.
5. **Flotte Privée** : menu du § 7.2 de `docs/FLOTTE-PRIVEE.md` inchangé (tests de `dashboard-nav.test.ts`) ; pages et
   actions masquées ET refusées (`private-fleet-guards.test.ts`).
6. **Réseau partagé** : aucun mot de `NETWORK_FORBIDDEN_WORDS` ; `NETWORK_POSITIONING` complet dans la convention
   (`network-terms.test.ts`) ; liens sans préchargement et aucune couleur en dur dans les fichiers contrôlés par
   `web2-texts.test.ts`.
7. **Secrets** : une clé API n'est affichée qu'une fois ; jeton WhatsApp en écriture seule ; rien n'est relu ni affiché.
8. **Conformité** : aucune nouvelle clé de stockage local (la refonte n'en prévoit aucune ; sinon ligne dans `/cookies`
   d'abord) ; aucun script, police ou vidéo tiers ; lien `target="_blank"` avec `NewTabHint` ; pages légales à un clic
   depuis la barre latérale et le tiroir mobile.
9. **Tests** : aucun test supprimé, désactivé ou affaibli. Un libellé changé = test mis à jour dans le même lot en
   gardant ce qu'il protège ; un comportement nouveau = un test.

---

## 2. Principes

1. **Épuré.** Chaque écran montre ce qui sert à la tâche du jour. Le reste existe toujours, mais replié, déplacé sur sa
   page ou résumé en une ligne. On retire du visible, on ne retire pas de fonction.
2. **Une action principale par écran.** Un seul bouton plein (lime) par page ou par fenêtre ; les autres actions sont
   secondaires, dans un menu « Plus d'actions » ou en bas dans une « Zone sensible ». Une action impossible n'est jamais
   l'action principale.
3. **Vocabulaire simple.** Le mot du métier, en français, le même partout (§ 4) : jamais un code brut, un nom de table,
   un statut anglais ou un nom de technologie à l'écran. Le code brut, s'il aide le support, n'apparaît que dans un
   détail replié.
4. **Réglages avancés repliés.** Ce qui se règle une fois (paramètres techniques, intégrations, mécanique des frais) est
   dans un repli au titre explicite (« Réglages avancés », « Détails techniques », « Comment sont calculés les frais ? »).
   Un repli s'ouvre de lui-même quand il contient une erreur ou un blocage.
5. **Résumés en tête.** Une page commence par ce qui demande une action (« À traiter »), puis par l'état en une phrase
   ou quatre chiffres au plus, puis le détail. Une fiche commence par son identité et ce qui est « À surveiller ».
6. **États vides qui guident.** Un état vide dit pourquoi c'est vide et quoi faire ensuite ; un filtre vide n'invite
   jamais à « ajouter » ce qui existe déjà ; une erreur de lecture n'affiche jamais un faux zéro.
7. **Le téléphone compte.** Aucun défilement horizontal de page à 390 px ; listes en cartes ; boutons et entrées de
   menu d'au moins 44 px au toucher. Les gérants et le chauffeur Flotte Privée consultent d'abord sur téléphone.
8. **Rien de grave en un clic.** Tout ce qui coupe un accès, un service ou bloque quelqu'un demande une confirmation
   qui dit la conséquence, avec un bouton qui nomme l'action (« Révoquer la clé »), jamais « OK ».
9. **Ne déplacer que ce qui gêne.** Les noms, adresses et ordres qui fonctionnent restent ; aucune URL ne change.

---

## 3. Règles de design communes

Elles s'appliquent à tout fichier touché par un lot (CLAUDE.md s'applique en entier : jetons de couleur, `@utility`,
`Field`, `submitWith`, `runAction`, `fieldErrors` + `describeError`, `prefetch={false}`, `useLiveSync`, Intl partagé,
typographie française, contraste ≥ 4,5:1, `NewTabHint`).

### 3.1 Coquille (barre latérale et menu mobile)

- Une seule zone défilante contient le menu puis les informations de pied (cookies, liens légaux) ; restent fixes
  l'en-tête (logo, cloche ou badge), le bloc de l'organisation et le menu du compte. À 1440×900 (bandeau cookies
  ouvert) et à 1366×768, tout le menu est visible sans défiler.
- Au plus quatre sections métier (plus « Plateforme » ou « Mon espace » si besoin). **Le libellé du menu est le titre
  (h1) de la page.**
- Chaque pastille porte un `aria-label` qui dit ce qu'elle compte (« 3 signalements de fraude à examiner »).
- Entrées de 32 px dans la barre fixe, de 44 px dans le tiroir mobile ; retour visuel immédiat au clic (`useLinkStatus`).

### 3.2 En-têtes de page

- Un seul h1 ; **pas de sur-titre** (il répétait la section du menu, parfois à tort) ; description d'une phrase,
  120 caractères au plus. Un texte plus long va dans un repli « En savoir plus ».
- Fiches (course, chauffeur, client, compte de frais, demande de contact, réservation) : `PageHeader` avec lien de retour
  (« ← Courses »), badges à côté du titre et ligne d'informations dessous. Plus d'en-tête refait à la main.
- Action principale à droite (première dans l'ordre du code ; pleine largeur sous 640 px).

### 3.3 Chiffres clés

- Une rangée de quatre `StatCard` au plus. Chiffre en couleur neutre ; **couleur réservée à ce qui demande une action**
  (rouge : retard, échec, blocage ; ambre : à faire). Lime, cyan, violet ne servent plus à décorer un chiffre.
- Un chiffre qui mène à une liste est un lien (`StatCard href`). Les chiffres secondaires vont dans un repli « Plus de
  chiffres » ou dans une phrase (« Ce mois-ci : … »).
- Lecture impossible → « — » et une phrase, jamais 0.

### 3.4 Listes et tableaux

- Sous 768 px (`md`), une liste de cartes (`ListCard` : titre, statut à droite, une à trois lignes d'informations, toute
  la carte est un seul lien) ; à partir de `md`, le tableau. Les deux rendus coexistent, l'un masqué par CSS
  (`display: none`, donc jamais lu deux fois).
- **Aucun bouton d'action dupliqué** entre la carte et le tableau : seul le lien de la ligne est rendu deux fois ; les
  actions restent dans un seul rendu ou sur la fiche.
- Statut et prix ne se coupent jamais (`whitespace-nowrap`) ; trajet et client se tronquent avec le texte entier en
  `title`.
- Liste longue : 50 lignes au plus par page (`Pagination`) ; jamais 120 ou 200 lignes d'un bloc.

### 3.5 Onglets et filtres

- Un seul composant, `FilterTabs` (liens, `prefetch={false}`, `aria-current="page"`) en deux apparences : « rubriques »
  (soulignées, dans l'en-tête : Réglages, Supervision) et « filtres » (pastilles, compteur facultatif, rouge si alerte,
  grisé à zéro sauf l'onglet actif). L'onglet actif est toujours ramené dans la zone visible sur téléphone ; un fondu
  signale une barre qui déborde.
- Les clés d'URL existantes (`?filter=`, `?tab=`, `?type=`, `?driver=`, `#reglements`, `#frais-plateforme`,
  `#a-traiter`, `#a-valider`) ne changent jamais : elles sont utilisées par des alertes, des e-mails et des favoris.
- Le tablist client d'Encaissements (`role="tab"`) garde sa sémantique ; seul son style suit.

### 3.6 Formulaires et fenêtres

- `Field` pour tout champ (libellé visible, aide, erreur reliés) ; erreurs sous le champ concerné (`fieldErrors`), le
  toast ne fait que résumer.
- Exemples en placeholder préfixés « ex. : » ; `inputMode` et `autoComplete` adaptés (e-mail, téléphone, SIRET, code
  postal, montants décimaux).
- Champs facultatifs ou avancés dans un `Disclosure` qui s'ouvre si l'un d'eux a une erreur.
- Pied de fenêtre `DialogFooter` : « Retour » (ferme sans rien faire) puis l'action ; empilés pleine largeur sous
  640 px, action en haut ; collé en bas des longues fenêtres sur téléphone.
- « Annuler » n'est jamais un bouton de fermeture : c'est toujours une action métier suivie de son objet (« Annuler la
  course », « Annuler la commission »).

### 3.7 Actions sensibles

- Révoquer ou remplacer une clé, retirer un accès, changer un rôle, déconnecter ou désactiver un chauffeur, suspendre,
  archiver, bannir, « Pas reçu » : `ConfirmDialog` qui dit la conséquence en une phrase vérifiée dans le code (jamais
  inventée), bouton verbe + objet. Les dialogues qui existent déjà gardent leur texte et leurs champs.
- Par ligne : une action principale et une secondaire visibles au plus, le reste dans un menu « ⋮ » (`DropdownMenu`)
  dont chaque entrée garde son nom accessible.
- Sur une fiche, les actions graves vont en bas (« Zone sensible ») ou en dernier dans « Plus d'actions », en rouge.

### 3.8 Replis

- `Disclosure` (balise native `details`/`summary`) : titre qui dit ce qu'il y a dedans, cible de 44 px, focus visible,
  fermé par défaut, ouvert d'office en cas d'erreur ou de blocage, ancre (`id`) possible.
- Aucun état de repli mémorisé (pas de nouvelle clé de stockage).

### 3.9 États vides, erreurs, encadrés

- Grand `EmptyState` seulement pour une page entièrement vide ; dans une carte, `EmptyState size="compact"` (une ligne).
- Filtre vide : « Aucun chauffeur dans « Désactivés » » + lien « Voir tous les chauffeurs ».
- Erreur de lecture : « Lecture impossible, réessayez dans un instant. » ; jamais le message brut de la base à l'écran
  (journalisé côté serveur).
- Encadrés : un seul composant, `Callout` (tons neutre, info, attention, danger, succès), `role="status"` ou
  `role="alert"` selon l'urgence. Les encadrés faits main des fichiers touchés passent à `Callout`.

### 3.10 Couleurs, texte, accessibilité

- Jetons de `globals.css` seulement ; jamais d'opacité sur un texte à lire (la clé révoquée à 55 % tombait à 2,6:1).
- Texte à lire ≥ 12 px ; les primitives (`components/ui`, `components/shell`) n'ont plus de taille sous 12 px. Pas de
  remplacement de masse des tailles dans les pages : chaque lot aligne les fichiers qu'il touche.
- Boutons à bascule avec `aria-pressed` ; choix exclusifs en `radiogroup` (`aria-checked`) avec une légende.
- Zone qui défile d'elle-même (`max-h-… overflow-y-auto`) : un `div` atteignable au clavier et nommé
  (`tabIndex={0} role="region" aria-label="…"`) qui CONTIENT la liste (`<ul className="divide-y …">`), jamais
  `<ul role="region">` (la liste disparaît, ses `li` deviennent orphelins : WCAG 1.3.1). Contrôlé par
  `components/ui/aria-roles.test.ts` (rôles permis sur `ul`, `ol`, `li` ; zones défilantes ; régions nommées).
- Nombres et dates par `formatNumber`, `formatPrice`, `dateTimeFormat` de `@rydar/shared` (« 21,3 s », jamais
  « 21.3 s ») ; espace insécable avant « : ; ! ? » et dans « 12 h », « 4 km », « 5 € ».
- Aucune animation en boucle hors indicateur de chargement ; rien de nouveau avec « réduire les animations ».

### 3.11 Conventions techniques

- `<Link prefetch={false}>` partout, admin compris (contrôlé par `dashboard-links.test.ts` étendu en R1).
- Jamais `new Intl.*` au rendu (`dateTimeFormat` / `numberFormat` mémorisés).
- Toute page `app/admin/**/page.tsx` appelle `requireSuperAdmin()` avant toute lecture (test statique en R2).
- Action serveur dans un clic : `start(() => runAction(...))` ; formulaires `onSubmit={submitWith(fn)}` ; recherche =
  formulaire GET vers l'adresse de la page (jamais une action serveur), comme Courses et Chauffeurs aujourd'hui.
- Pages en temps réel : `useLiveSync` / `LiveRefresh` gardés tels quels quand un bloc est déplacé.
- Un composant commun ne change que par ajout rétrocompatible (propriété facultative) après R1.

### 3.12 Composants communs (créés ou complétés en R1)

| Composant | Fichier | Rôle | Remplace |
|---|---|---|---|
| `Sidebar` (zone défilante unique, bloc d'organisation statique, `match`) | `components/shell/sidebar.tsx` | coquille | barre tronquée |
| `NavLinkPending` | `components/shell/nav-pending.tsx` | retour au clic (`useLinkStatus`) | rien |
| `PageHeader` (`back`, `badges`, `meta`) / `StatCard` (`href`, `active`) | `components/layout/page-header.tsx` | en-têtes, chiffres | 5 en-têtes de fiche faits main |
| `CardHeader` (retour à la ligne) | `components/ui/card.tsx` | cartes | débordements à 390 px |
| `MobileList`, `DesktopTable`, `ListCard` | `components/ui/table.tsx` | listes | tableaux qui défilent |
| `FilterTabs` | `components/ui/filter-tabs.tsx` | onglets et filtres | 4 styles différents |
| `Disclosure` | `components/ui/disclosure.tsx` | replis | 7 `details` ad hoc |
| `Callout` | `components/ui/callout.tsx` | encadrés | ~60 encadrés faits main |
| `EmptyState size="compact"` | `components/ui/misc.tsx` | états vides | grandes cartes vides |
| `ConfirmDialog`, `DialogFooter` | `components/ui/confirm-dialog.tsx`, `components/ui/dialog.tsx` | confirmations, pieds | actions en un clic |
| `Pagination` | `components/ui/pagination.tsx` | listes longues | 2 paginations copiées |
| `SearchField` | `components/ui/search-field.tsx` | recherche GET | 6 champs faits main |
| `CopyButton` | `components/ui/copy-button.tsx` | copier | 3 variantes |
| `SwitchRow` (aide par état) | `components/ui/switch-row.tsx` | interrupteurs | `SwitchRow` local des réglages |
| Lexique (`orgWords`, `plural`, libellés de statuts) | `lib/wording.ts` | vocabulaire | codes bruts, « votre centrale » chez une flotte |

---

## 4. Lexique

Un mot par chose, partout. « Où » indique les écrans concernés ; la colonne de droite liste ce qui disparaît de
l'affichage (le code et la base gardent leurs noms).

| On dit | On ne dit plus à l'écran | Où |
|---|---|---|
| Client (pour le super admin) ; types : Flotte, Centrale à commission, Flotte Privée | rattacheur, tenant, organisation (titres), « Option 1 — Flotte », « Option 2 — Centrale » | super admin |
| Frais Rydar | Frais plateforme (titres, menus, cartes) — le terme reste dans les textes juridiques | super admin, Encaissements, relevés |
| Commissions des centrales | Centrales (page de suivi des commissions) | super admin |
| Supervision (Dispatch & erreurs, Notifications, E-mails, Sécurité & audit) | Supervision éparpillée dans le menu | super admin |
| Abonnements par mois | MRR | super admin |
| notifications envoyées sur les téléphones | push, outbox, worker, Expo / FCM / APNs | super admin |
| chaque client a son espace séparé ; limites contrôlées par le serveur | tenant isolé (RLS), triggers | super admin |
| Envoyée, En file, Envoi en cours, Échec, Annulée | sent, queued, sending, failed, cancelled | notifications |
| Info, Attention, Critique ; Super admin, Système, Utilisateur | info, warning, critical ; super_admin, system | audit |
| Détail, Info, Réussi, Attention, Erreur | DBG, INF, OK, WRN, ERR, Debug | journaux de dispatch |
| Actif, Période d'essai, Paiement en retard, Impayé, Résilié | active, trialing, past_due, unpaid, canceled | abonnements |
| À payer, Brouillon, Payée, Annulée, Irrécouvrable | open, draft, paid, void, uncollectible | factures |
| Application jamais ouverte ou notifications refusées | NO_PUSH_TOKEN | notifications, fiche client |
| Immédiate(s) | Instantanée(s) | courses, carte en direct |
| Saisie manuelle ; Votre site ; Mini-site | Dashboard ; Site (API) | source d'une course, statistiques |
| tableau de bord | dashboard | partout |
| Chronologie ; Détails techniques | Timeline ; Vue technique, Debug | fiche course, journal |
| Relancer la recherche ; Créer la course | Relancer le dispatch ; Créer et dispatcher | courses |
| Retour (fermer une fenêtre) | Annuler (pour fermer) | fenêtres |
| votre flotte / votre centrale selon le modèle (`orgWords`) | « votre centrale » chez une flotte, « commissions jamais réglées » chez une flotte | réseau, chauffeurs, réglages, messages |
| Identité de votre entreprise | Identité de la centrale | Réglages › Organisation |
| Chiffre d'affaires (30 j) ; courses proposées | CA 30 j ; offres | chauffeurs |
| Annuler la commission ; Annuler le versement ; Commissions annulées | Annuler la dette ; Dettes chauffeurs annulées | Encaissements |
| Paiement reçu ; Réglés | Commission reçue ; Encaissés (onglet) | Encaissements, réseau partagé |
| Détail des frais ; Reste dû au … ; part à vous reverser | Écritures ; Solde d'ouverture / de clôture ; reversement | relevés, réseau partagé |
| message à modérer ; signalement (= alerte route, mot de l'app) | message signalé | Messages |
| Classer sans suite ; Connexion bloquée (identifiants du chauffeur) | Classer ; Connexion bloquée au niveau du compte (Auth) | signalements de fraude |
| Nom commercial ; Identifiant ; E-mail de contact | Nom de la centrale ; Identifiant (slug) ; E-mail de la centrale | création d'un client |
| Points forts affichés | Arguments | offres |
| Non compris dans votre offre (+ lien « Voir les offres ») | « offre Pro », « Offre Business » écrits en dur | API, mini-site, statistiques |

Noms **protégés** (cités par les CGV, des messages SQL ou le modèle WhatsApp approuvé : jamais renommés) :
« Encaissements », « Frais Rydar », « Réseau partagé », « Mini-site » ; « frais plateforme » dans les textes juridiques.
Noms **gardés** par décision de la refonte : « Inscriptions » / « Réseau » (changement réservé au propriétaire, § 7),
« Commission & encaissement » (onglet cité par `docs/WHATSAPP.md`), « Journal du dispatch », « API & site web »,
entrées du menu Flotte Privée (§ 7.2 de la spécification).

---

## 5. Décisions par zone

### 5.1 Coquille et système de design

- **Garder** : `Field` et le câblage des erreurs, `Button` « en cours » focalisable, retour du focus des fenêtres,
  `SkipToContent`, `ErrorFallback`, jetons de couleur, pastilles avec `aria-label`, `prefetch={false}`.
- **Regrouper** : une seule zone défilante dans la barre ; menu client en « Au quotidien » et « Gestion » (§ 8, R1) ;
  menu admin en « Pilotage », « Clients », « Argent », « Plateforme » (R2).
- **Replier** : rien dans la coquille ; les liens légaux restent visibles en bas de la zone défilante, en compact.
- **Renommer** : — (les libellés du menu client ne changent pas).
- **Supprimer du visible** : encadré « Mode plateforme — … tenants … » (remplacé par un badge « Super admin ») ; chevrons et
  menu « Organisations » d'un compte à une seule organisation ; sur-titres des en-têtes ; « API & site web » et
  « Mini-site » du menu du dispatcher (pages sans action pour lui, toujours accessibles par leur adresse).
- **Corriger** : entrées cachées à 1440×900 ; débordement des en-têtes de carte à 390 px ; page 404 qui sortait de
  l'espace connecté vers le site vitrine ; aucun retour au clic.

### 5.2 Super admin

- **Garder** : confirmations, notes d'accord, cases de bannissement, `PlatformLive`, carte en direct, toutes les actions.
- **Regrouper** : « À traiter » en tête de l'accueil (6 compteurs du layout + informations légales) ; un seul tableau
  « Clients » sur l'accueil (fusion « Effectifs par organisation » + « Activité des rattacheurs ») ; journaux techniques
  sous « Supervision » (4 onglets) ; réglages de la plateforme (coordonnées de paiement, WhatsApp de Rydar, interrupteur
  des mini-sites) sur une page `/admin/reglages` ; signalements de fraude sur leur page `/admin/signalements` (la
  pastille suit) ; diagnostic des e-mails sur `/admin/emails` (bandeau compact sur Demandes de contact).
- **Replier** : effectifs détaillés ; « Modèle et frais Rydar » de la fiche (résumé + « Modifier ») ; « Activité » de la
  fiche ; « Offre de service et réseau partagé » ; limites spécifiques d'un client ; 4 chiffres secondaires et 8 règles
  des frais ; écritures du relevé au-delà de 15 ; formulaire « Conditions » ; détails techniques des e-mails ;
  positionnement du réseau partagé ; détail des lignes d'audit (IP, entité).
- **Renommer** : Rattacheurs → Clients ; Frais plateforme → Frais Rydar ; Centrales → Commissions des centrales ;
  « Nouveau rattacheur » + « Nouveau client Flotte Privée » → un seul « Nouveau client » (choix du type) ; statuts et
  codes en français (§ 4).
- **Supprimer du visible** : « Option 1 / Option 2 » ; carte « Clés API » de la fiche ; indicateurs en double avec
  `/admin/frais` sur `/admin/centrales` ; colonne « Identifiant » du tableau des clients ; écritures automatiques
  « Info » du système dans la vue par défaut de l'audit (les « Attention » et « Critique » restent toujours visibles).
- **Corriger** : grilles fixes (dispatch, notifications, audit) et tableaux coupés sur téléphone ; `new Intl` et
  fonctions de mois recopiées dans `centrales/page.tsx` ; liens sans `prefetch` ; dates ISO de `/admin/legal` ; mot de
  passe provisoire proposé par défaut dans « Donner un accès » (l'invitation par e-mail devient le défaut) ; champs
  « Chauffeurs max. » et « Administrateurs » modifiables en Flotte Privée (verrouillés, la base imposant 1).

### 5.3 Espaces clients : opérations (En direct, courses, chauffeurs, statistiques, agenda)

- **Garder** : carte plein écran et panneau de course de l'accueil, compteurs de vagues, « Réponse avant… », fenêtres de
  confirmation existantes, agenda.
- **Regrouper** : un seul « À traiter » sur En direct (l'onglet « Alertes » change de nom, même contenu) ; filtres des
  courses en deux groupes (statut, puis type) ; chiffres de la liste des chauffeurs = filtres ; liste « Attribuer »
  identique depuis l'accueil et la fiche, groupée (disponibles, occupés, hors ligne replié).
- **Replier** : vol, e-mail et note de « Nouvelle course » (ouverts d'office pour un aéroport ou une erreur) ; options
  avancées du journal (détails, présence) ; carte de la flotte sur Chauffeurs ; historique d'un chauffeur au-delà de 10
  lignes sur téléphone.
- **Renommer** : § 4 (Immédiate, Saisie manuelle, Votre site, Chronologie, Relancer la recherche, Créer la course…).
- **Supprimer du visible** : invite `dispatch@…`, JSON au survol, mode « Debug » activé par défaut ; colonne « Compte »
  répétée (badge seulement si le compte n'est pas actif) ; 4 à 5 cartes cadenas identiques des statistiques ; graphiques
  vides d'une période sans course.
- **Corriger** : listes illisibles à 390 px ; « Offres envoyées » écrasé sur téléphone ; « 21.3 s » ; étape « Acceptée ·
  en cours » sur une course proposée ; bandeau des frais par-dessus les outils de la carte ; chiffres du jour et liste
  des chauffeurs absents sous 1400 / 1280 px ; « Déconnecter » et « Désactiver » en un clic ; filtre vide qui invite à
  « Ajouter vos chauffeurs ».

### 5.4 Flotte Privée

- **Garder** : menu du § 7.2, Premiers pas, « Je la prends », « Refuser », « Appeler », agenda, Mon site en lecture
  seule, gardes « masqué ET refusé ».
- **Regrouper** : sur téléphone, « À traiter » puis « Aujourd'hui » avant les chiffres du mois.
- **Replier** : rien de plus (l'espace est déjà court).
- **Renommer** : « Fixer le prix » quand une réservation n'a pas de prix ; onglets de Réglages « Coordonnées » (au lieu
  de « Mon entreprise », déjà nom de la section du menu) et « Délais et rappels » (au lieu de « Réservations », nom de
  l'entrée du menu) ; chronologie dans les mots du chauffeur (« Réservation reçue de votre site ») par une table
  d'affichage, les messages en base ne changent pas.
- **Supprimer du visible** : « Annuler » des cartes de l'accueil (reste sur la fiche) ; clé « rdk_live_… » et « Dernière
  utilisation » de l'accueil (restent dans « Détails techniques » de Mon site) ; étiquette « Planifiée » (toutes le
  sont) ; jauges « Chauffeurs 1/1 » et « Administrateurs 1/1 » en rouge ; « Le plus choisi ».
- **Corriger** : listes tronquées de Mon site et des Réservations à 390 px ; « (Europe/Paris) » affiché par défaut ;
  « Exigé — déposez-le… » répété 5 fois ; e-mail qui déborde dans Mon profil.

### 5.5 Argent et réseau côté client

- **Garder** : carte des frais Rydar sur Encaissements avec les informations des CGV visibles ; ancres
  `#frais-plateforme` et `#reglements` ; sélection groupée ; contrat d'URL ; textes juridiques.
- **Regrouper** : un seul montant principal des frais Rydar (« À payer maintenant », sinon « À régler avant le … »,
  sinon « Rien à régler »), le même sur la carte, le bandeau et la fenêtre « J'ai payé » ; « Soldes par chauffeur »
  devient la vue « Par chauffeur » de « Règlements » ; tuiles réduites à 4 dans l'ordre d'action.
- **Replier** : détail de la carte Rydar (4 chiffres, origine de l'argent, historique), ouvert d'office en cas de
  blocage ; RIB dans « Payer par virement » ; référence et note de « J'ai payé » ; écritures du relevé au-delà de 20 ;
  « Comment sont calculés vos frais Rydar » ; options du lien d'inscription ; filtres secondaires du réseau partagé.
- **Renommer** : § 4 (Annuler la commission, Réglés, Paiement reçu, Détail des frais, Reste dû…, message à modérer).
- **Supprimer du visible** : tuile « Frais plateforme du mois » (doublon) ; « ↙ à encaisser » sur une ligne réglée ;
  légende colorée loin des montants (phrase « 30 € = 19 € chauffeur + 6 € commission + 5 € plateforme » partout) ; mois
  sans activité du relevé ; tuiles StatCard non cliquables du réseau ; blocs vides du réseau ; téléphone répété en clair
  au-dessus de sa puce masquée.
- **Corriger** : « Pas reçu » (qui bloque le chauffeur) en bouton direct sur une commission ni déclarée ni échue → dans
  le menu ⋮ (même dialogue, motif obligatoire) ; aide « Lien actif » fausse quand l'interrupteur est allumé ;
  « ci-contre » faux sur téléphone ; « votre centrale » chez une flotte ; moyens de paiement dans des ordres différents ;
  `new Intl` au rendu.

### 5.6 Réglages, API & site web, mini-site

- **Garder** : actions, schémas et gardes ; phrases de `dashboard-integrations.test.ts` mot pour mot ; libellé
  « Webhooks » ; titre « Commission & encaissement » ; jeton WhatsApp en écriture seule.
- **Regrouper** : une seule barre « Enregistrer » pour la grille tarifaire ; Organisation en premier onglet (pour tous) ;
  ordre Commission → Encaissement → Relances → Blocages ; API & site web : état du site d'abord, clés, webhooks, puis
  documentation.
- **Replier** : réglages avancés du dispatch (seuil de course immédiate, recherche à T-, maximum par vague, fraîcheur
  GPS) ; formulaire WhatsApp Business (Meta) tant qu'il n'est pas relié, puis derrière « Modifier la connexion » ;
  message du bouton « Réclamer » ; variables du lien de paiement ; documentation API (points d'entrée, exemples,
  journal) ; « Limite de débit » du dialogue « Nouvelle clé » ; mot de passe provisoire d'un nouveau membre ;
  comparaison des offres quand un abonnement est actif.
- **Renommer** : § 4 et libellés du dispatch en français courant (R10) ; « Passer administrateur » / « Passer
  dispatcher » ; portées de clé (« Annuler des courses », « Calculer des devis », « Suivre les courses »).
- **Supprimer du visible** : valeurs de tarif préremplies d'une catégorie sans grille (10 / 2 / 0,5 / 30 / 15) ; « Gérer »
  sans abonnement Stripe ; « Choisir cette offre » quand le serveur refuserait (abonnement en cours) ; onglet
  « Abonnement » du dispatcher (données réservées aux administrateurs) ; carte « Clés actives » de Mon site.
- **Corriger** : débordements à 390 px (onglets des exemples, journal des requêtes, grille du mini-site) ; révocation,
  rotation, changement de rôle et retrait d'accès sans confirmation ; statuts en anglais ; erreurs seulement en toast
  (Organisation, Tarifs, Équipe, Dispatch) ; onglets coupés sur téléphone ; changement d'onglet qui efface la saisie ;
  couleurs en dur ; `aria-pressed` manquants.

---

## 6. Propositions écartées, modifiées ou reportées

| Proposition des audits | Décision | Raison |
|---|---|---|
| Abonnement : « Souscrire à mon offre » pendant l'essai (payer l'offre attribuée) | Écartée → propriétaire (§ 7) | Change ce que permet le paiement : décision commerciale, pas d'interface. |
| Abonnement : « Choisir cette offre » ouvre le portail Stripe quand un abonnement existe | Modifiée | Le portail peut ne pas permettre de changer d'offre (configuration Stripe, DEPLOYMENT) : on n'ouvre aucun nouveau chemin de paiement ; on affiche « Pour changer d'offre, utilisez « Gérer mon abonnement » ». |
| Déplacer la commission chauffeur d'une flotte de Dispatch vers Tarifs | Écartée | `updateDispatchSettings` réécrit tous les réglages d'un coup : risque d'écraser une modification parallèle. Un lien suffit. |
| Entrée « Agenda » pour flottes et centrales | Propriétaire (§ 7) | Décision produit (FLOTTE-PRIVEE § 16). |
| « Inscriptions » pour les deux modèles | Propriétaire (§ 7) | Vocabulaire métier des centrales et ligne de CLAUDE.md. |
| Barre d'onglets en bas d'écran (Flotte Privée) | Reportée | Recouvre les barres « Enregistrer » collantes et les fenêtres ; l'app chauffeur couvre l'usage sur téléphone. À revoir après la recette. |
| Échelle typographique sur ~1 000 classes | Réduite | Primitives seulement (R1) et fichiers touchés par chaque lot ; pas de remplacement de masse (risque de troncatures partout). |
| Menu du compte enrichi (mot de passe, changement d'organisation) | Reportée | Gain faible ; le sélecteur d'organisation est déjà dans la barre. |
| « Bannir définitivement » dans « Plus d'actions » de la fiche chauffeur | Modifiée | Reste dans la carte « Sécurité » en bas de la fiche (propriétaire et administrateurs seulement), un seul point d'entrée, dialogue et cases inchangés. |
| Origines autorisées (CORS) repliées dans « Nouvelle clé » | Modifiée | Réglage de sécurité (fait une clé navigateur) : reste visible ; seule la limite de débit est repliée. |
| Mini-site : barre d'enregistrement unique, replis, logo | Reportée | Mini-sites coupés en production (006200) ; on corrige le débordement, le vocabulaire et on affiche la liste « Pour mettre en ligne » (déjà calculée). |
| Descriptions d'en-tête tronquées (`line-clamp`) | Écartée | Cache du texte sans moyen de le lire ; on raccourcit à la source. |
| Audit : masquer par défaut toutes les écritures du système | Modifiée | Seules les entrées « Info » du système sont masquées par défaut ; « Attention » et « Critique » restent toujours visibles. |
| Mémoriser l'état des replis ou des vues | Écartée | Aucune nouvelle clé de stockage (CNIL, `/cookies`). |
| Modifier `DISPATCH_MODEL_META.short` dans `@rydar/shared` | Écartée | Inutile : le web n'utilise plus que `.label` ; constante laissée telle quelle. |
| Renommer « Journal du dispatch » | Écartée | Le nom est compris ; c'est le contenu qui était technique (corrigé en R7). |

---

## 7. Décisions qui reviennent au propriétaire

1. **Agenda pour flottes et centrales** : ajouter l'entrée « Agenda » au menu (la page marche déjà pour toute
   organisation ; limite de 1 000 courses par fenêtre, message prévu). Une ligne dans `dashboard-nav.ts` et son test.
2. **« Inscriptions » au lieu de « Réseau » pour les centrales** : `joinNavLabel` renverrait toujours « Inscriptions »
   (plus de confusion avec « Réseau partagé ») ; la ligne « Lien /rejoindre » de CLAUDE.md serait à ajuster.
3. **Abonnement pendant l'essai** : permettre au client de payer l'offre que Rydar lui a attribuée (le serveur l'accepte
   déjà).
4. **CLAUDE.md** : la refonte n'y touche pas ; après R11, une ligne « Design » pourrait renvoyer à ce document (texte à
   valider par le propriétaire).
5. **Tutoriel** (§ 10) : déclenchement, mémoire de la progression (base ou stockage local), place de l'app chauffeur.

Décisions prises par la direction de la refonte, réversibles en une ligne : onglet « Organisation » ouvert par défaut
dans Réglages (R10) ; « Annuler » retiré des cartes de l'accueil Flotte Privée (R8, spec mise à jour) ; menu du
dispatcher sans « API & site web » ni « Mini-site » (R1).

---

## 8. Lots

### 8.0 Règles communes à tous les lots

- **Ordre imposé** : R1, puis R2 → R11 dans l'ordre. Un lot ne commence qu'après le précédent (fichiers partagés :
  lexique, composants communs, menus).
- Ne modifier que les **chemins autorisés** du lot. Exceptions permises à tous les lots : ajouts rétrocompatibles dans
  `apps/web/components/ui/**` et ajouts de libellés dans `apps/web/lib/wording.ts` (+ son test), signalés dans le
  compte rendu.
- Garde-fous du § 1.3 et règles du § 3 ; lexique du § 4.
- Base de test dédiée pour `pnpm test:db` : `TEST_DATABASE_NAME=rydar_test_<lot>` ; `PGPASSWORD=postgres` ; PostgreSQL
  local : `pg_ctlcluster 16 main start`. Shell : jamais `pkill -f <motif>` si le motif est dans la commande.
- Chaque lot : captures « après » des pages touchées (1440×900 et 390×844), contrôle de débordement et de hauteur
  (§ 9.3), scripts de recette concernés adaptés (hors dépôt) et relancés.
- Commit seulement si le rôle du lot le demande : `git add` des seuls fichiers du lot, message en français ; jamais de
  push.
- Contrôles minimaux de chaque lot : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/web build`.

### 8.1 Tableau des lots

| Lot | Titre | Dépend de | Statut |
|---|---|---|---|
| R1 | Coquille et composants communs | — | fait : `723e353` |
| R2 | Super admin : menu, pages regroupées et « Supervision » | R1 | fait : `d465c6b` |
| R3 | Super admin : accueil « À traiter » et liste des clients | R2 | fait : `cd67e05` |
| R4 | Super admin : fiche d'un client | R3 | fait : `8033cba` |
| R5 | Super admin : argent (Frais Rydar, commissions des centrales, offres) | R4 | fait : `b13a708` |
| R6 | Super admin : supervision et pages annexes | R5 | fait : `0f738ab` |
| R7 | Clients : En direct, courses et journal du dispatch | R6 | fait : `f45a139` |
| R8 | Clients : chauffeurs, statistiques, agenda et espace Flotte Privée | R7 | fait : `d2a3e90` |
| R9 | Clients : argent, inscriptions, réseau partagé et messages | R8 | fait : `8cfa19d` |
| R10 | Clients : réglages, API & site web, mini-site | R9 | fait : `b6c8ac5` |
| R11 | Contrôle final, recette et documentation | R1 à R10 | fait : commit « Refonte des panneaux (R11) : contrôle final, recette et documentation » (compte rendu : `docs/EN-COURS.md`) |
| Revue | Corrections UX (RV-01 à RV-19) et zones défilantes accessibles | R11 | fait : `6c2ce62`, `682aac8` |
| Contrôle final | Contrôles, recette Flotte Privée, captures définitives, correction de « Relancer » | Revue | fait : commit « Refonte des panneaux : contrôle final après la revue » (compte rendu : `docs/EN-COURS.md`) |

Écarts entre le plan et le code livré : § 8.2. Aucun lot n'a touché `supabase/`, `apps/driver/` ni `apps/worker/` ;
hors `apps/web`, seuls les libellés permis par le § 1.1 ont changé dans `packages/shared/src` (`RIDE_FILTERS`,
`RIDE_SOURCE_LABELS`, `RIDE_TYPE_LABELS`, `API_SCOPE_LABELS`, format mis en cache de `platformDueSummary`), avec
`docs/FLOTTE-PRIVEE.md` (§ 7.3, § 15.1).

### 8.2 Écarts entre le plan et le code livré

Relevés par chaque lot dans son compte rendu ; le code fait foi. Aucun ne retire une garde, une confirmation ou une
action, ni ne touche le SQL ou l'app chauffeur.

- **R1** : un libellé long du menu passe sur deux lignes au lieu d'être coupé (seul cas mesuré : « Suppressions de
  comptes » avec sa pastille, 42 px) ; barre de progression du tiroir limitée à 10 s et ignorée pour un Ctrl / Cmd-clic ;
  pendant la transition, un lien de retour passé à `eyebrow` (élément) restait affiché (propriété retirée en R11).
- **R2** : pastille d'en-tête retirée de Signalements de fraude (redondante avec le menu) ; encadrés de renvoi sur Frais
  Rydar (coordonnées de paiement absentes) et Offres & limites (mini-sites coupés) ; Commissions des centrales :
  indicateur « Signalements » en lien, description remplacée (elle citait les signalements) ; bouton d'en-tête
  « Commissions des centrales » sur Frais Rydar ; fenêtres touchées fermées par « Retour », boutons nommés par leur
  action ; animation retirée de la pastille « À examiner » ; espaces insécables dans les textes touchés.
- **R3** : lignes « À traiter » rangées par urgence, informations légales de l'éditeur en tête ; « Vérifier N
  suppression(s) de compte en échec ou en retard » (même compte que la pastille) ; « N en cours ou à venir » au lieu de
  « dont N en cours » (le compteur inclut les courses attribuées d'autres jours) ; sur téléphone, bouton « Carte en
  direct » masqué (le chiffre « Chauffeurs en ligne » y mène) et statut d'un client affiché seulement s'il n'est pas
  actif ; type modifiable dans le formulaire flotte / centrale par un choix à deux options (sans « Option 1 / 2 ») ;
  « Tout voir » avec un nom complet pour les lecteurs d'écran ; fonctions pures de la liste et de la fusion dans
  `platform-data.ts` (testées dans `admin-todo.test.ts`).
- **R4** : « Passer en Flotte Privée » mis en contour par un sélecteur CSS de `private-fleet-card.tsx` (le bouton vient
  de `PackConversionButtons`, dans `private-fleet.tsx`, hors des chemins du lot) ; `Disclosure` : chevron d'un repli
  imbriqué selon son propre état (corrigé, testé) ; libellés `offer_closed` et `wake_expired` ajoutés au lexique ;
  « Échu » → « À payer maintenant », « Erreurs de dispatch » → « Alertes du dispatch », « … de l'organisation » →
  « … du client » ; « Enregistrer l'offre » inactif tant que rien n'a changé ; « À surveiller » compte aussi un compte
  invité jamais connecté ; Suspendre et Archiver en rouge ; champs « Frais plateforme (%) » et « Frais fixes par
  course » gardés (cités par les messages d'erreur de `app/admin/actions.ts`, visibles repli ouvert seulement).
- **R5** : sur Frais Rydar, les 4 chiffres restent avant « À traiter » ; lecture seule de
  `organizations.private_fleet` pour le badge Flotte Privée (§ 1.3, point 1) ; « Signalements » en carte-lien sur
  Commissions des centrales (seul affichage du nombre d'identités bannies de la plateforme) ; colonne « Frais du mois »
  retirée (doublon de Frais Rydar) ; `TermsForm` : seule l'aide du cycle passe de 11,5 à 12 px ; « Frais à facturer » :
  explication longue repliée, « ligne » au lieu d'« écriture » ; relevé : « Détail », « Aucun frais ce mois-ci. » ;
  fenêtre de relance : renvoi WhatsApp vers Réglages de la plateforme ; pied collé de la fenêtre d'offre corrigé à
  l'appel (`className`), composant commun inchangé.
- **R6** : Dispatch & erreurs décrit « Tous les clients, sur les 7 derniers jours. » (lexique « client ») ; Réseau
  partagé : organisations en une seule liste (action et ancre `#org-` rendues une fois), fenêtres fermées par
  « Retour » ; `wording.test.ts` vérifie que toute action d'audit écrite par le web ou les migrations a son libellé.
- **R7** : chronologie : messages « par la centrale » rendus valables pour une flotte, type de course (immédiate ou
  planifiée) à l'heure de l'organisation ; états vides des courses avec « Voir toutes les courses » ; raccourcis
  d'adresses testés (`quick-places.test.ts`).
- **R8** : `Disclosure` gagne `lazy` (carte de la flotte chargée à l'ouverture ; ajout rétrocompatible, testé) ;
  « Ajouter » aussi sur une pièce refusée ; bouton « Nouvelle réservation (téléphone) » en Flotte Privée.
- **R9** : état d'un chauffeur « Bloqué · paiement contesté » en plus de « Bloqué · commission en retard » ; Messages :
  animation en boucle et textes sous 12 px retirés ; débordement du Réseau partagé à 390 px corrigé ; espaces
  insécables dans les textes touchés.
- **R10** : confirmation de sortie aussi sur Organisation ; rôle administrateur « Tout, sauf l'abonnement, les rôles et
  le retrait d'un accès » (le serveur réserve aussi ces deux actions au propriétaire) ; « Annuler l'invitation »
  confirmée ; `settings-forms.tsx` découpé en un fichier par formulaire ; moyens de paiement affichés dans l'ordre du
  reste du web (ordre enregistré inchangé) ; case et choix de rôle de « Ajouter un membre » à nom court, explication en
  description pour les lecteurs d'écran.
- **R11** : `primitives.test.ts` adapté au retrait d'`eyebrow`, sans cas retiré (absence de sur-titre vérifiée sur le
  composant et par un parcours des écrans qui l'utilisent ; lien de retour du relevé par `back`) ; adaptations des lots
  reportées dans les scripts de recette de `scratchpad/l7/e2e` (s2, s3, s6b, s7b), hors dépôt.
- **Contrôle final** (après la revue) : fenêtre « Relancer » des frais Rydar (`admin-account-actions.tsx`, observation
  de R11) : échec de la recherche du destinataire WhatsApp traité (`.catch`), test `admin-account-actions.test.ts` ;
  `/admin` à 390 : 2 206 px pour une cible ≤ 2 200 (annexe A), +26 px venus de la cible de 44 px de « Voir les
  données » (RV-06), écart gardé ; scripts de recette inchangés.

---

### R1 — Coquille et composants communs

- **Objectif** : un menu toujours entier, une barre plus légère, les briques communes, le lexique, une page introuvable
  dans l'espace connecté, et la règle « liens sans préchargement » contrôlée aussi dans l'admin.
- **Chemins autorisés** :
  - `apps/web/components/shell/sidebar.tsx`, `apps/web/components/shell/nav-pending.tsx` (nouveau),
    `apps/web/components/shell/admin-shell.tsx` (en-tête et pied de la barre ; les sections du menu admin restent,
    R2 les refait), `apps/web/components/shell/dashboard-shell.tsx` (propriétés passées à la barre),
    `apps/web/components/shell/dashboard-nav.ts`, `apps/web/components/shell/dashboard-nav.test.ts`,
    `apps/web/components/shell/dashboard-links.test.ts` ;
  - `apps/web/components/legal/legal-links.tsx` (variante compacte) ;
  - `apps/web/components/layout/page-header.tsx` ;
  - `apps/web/components/ui/**` ;
  - `apps/web/lib/wording.ts`, `apps/web/lib/wording.test.ts` (nouveaux) ;
  - `apps/web/app/dashboard/not-found.tsx`, `apps/web/app/admin/not-found.tsx`, `apps/web/lib/segment-not-found.test.ts`
    (nouveaux) ;
  - `apps/web/app/globals.css` (`@utility` seulement) ;
  - **uniquement pour ajouter `prefetch={false}` à un `<Link>`** : `apps/web/app/admin/**/*.tsx`,
    `apps/web/components/admin/**/*.tsx`, `apps/web/components/platform-fees/admin-*.tsx` (37 liens relevés).
- **Changements** :
  1. **Barre latérale** (`sidebar.tsx`) :
     - une seule zone défilante (`flex-1 overflow-y-auto`) contient, dans l'ordre, `<nav aria-label="Menu principal">`,
       `footer`, `notice` (cookies) et les liens légaux ; restent fixes l'en-tête (logo, `headerAction`), le bloc de
       l'organisation et le menu du compte ;
     - liens légaux en variante compacte (`LegalLinks variant="compact"` : 12 px, séparés par « · », cibles `min-h-6`),
       les 8 liens présents, à un clic ;
     - `orgs.length <= 1` : bloc statique (initiale, nom, ligne dessous) sans chevron ni menu « Organisations » ; sinon
       le sélecteur actuel. Dans les deux variantes, l'expression
       `{orgCaption ?? ORG_ROLE_LABELS[current.role as OrgRole] ?? current.role}` reste écrite telle quelle (testée) ;
     - entrées du tiroir mobile de 44 px (`h-11`) ; barre fixe : 32 px ;
     - retour au clic : un enfant de taille fixe de chaque lien du menu utilise `useLinkStatus`
       (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-link-status.md`) et ne change que
       l'opacité ; dans le tiroir mobile (fermé au clic), fine barre de progression sous la barre du haut, du clic
       jusqu'au changement d'adresse (10 s au plus), seulement si l'adresse visée diffère de l'adresse courante ;
     - `NavSection` : propriété facultative `match?: string[]` (préfixes qui rendent l'entrée active) ;
     - textes de la barre ≥ 12 px (titres de section, ligne sous le nom, pastilles).
  2. **`admin-shell.tsx`** : encadré « Mode plateforme — … » supprimé ; `headerAction` = badge « Super admin » (texte
     visible). Le `subtitle` (attribut `title` du logo, lu par les scripts de recette) ne change pas.
  3. **Menu client standard** (`dashboard-nav.ts` ; Flotte Privée inchangée) :
     - « Au quotidien » : En direct, Messages, Courses, Encaissements*, Réseau partagé*, Chauffeurs, Inscriptions /
       Réseau (`joinNavLabel` inchangé) — ordre et libellés actuels ;
     - « Gestion » : Statistiques, Journal du dispatch, API & site web (propriétaire et administrateur seulement),
       Mini-site* (propriétaire et administrateur seulement), Frais Rydar* (flotte, propriétaire et administrateur),
       Réglages ;
     - « Plateforme » : Espace super admin* (inchangé) ;
     - pastille de « Courses » : `badgeLabel` « N course(s) sans chauffeur (6 dernières heures et à venir) ».
     (* : mêmes conditions qu'aujourd'hui.)
  4. **`PageHeader`** : `eyebrow` n'est plus affiché (propriété gardée, `@deprecated`, retirée en R11) ; nouvelles
     propriétés `back` (`{ href, label }` → « ← label », `prefetch={false}`), `badges` (à côté du h1), `meta` (ligne
     sous le titre, `[overflow-wrap:anywhere]`) ; marges téléphone `px-4 pt-5` (`sm:px-6 sm:pt-7`) ; `PageBody`
     `px-4 py-6 sm:px-6 sm:py-8 lg:px-10`. **`StatCard`** : propriétés `href` (lien sans préchargement, survol, focus
     visible) et `active` (`aria-current="page"`).
  5. **`components/ui`** :
     - `card.tsx` : `CardHeader` en `flex-wrap` ; le bloc titre garde au moins `min(100%, 14rem)` ; une action trop
       large passe sous le titre (corrige les cartes Flotte Privée écrasées à 390 px) ;
     - `table.tsx` : `MobileList` (`md:hidden`), `DesktopTable` (`max-md:hidden`), `ListCard` (titre, statut à droite,
       1 à 3 lignes, chevron, toute la carte = un seul lien) + commentaire de la convention (§ 3.4) ;
     - `misc.tsx` : `EmptyState size="compact"` ;
     - nouveaux : `callout.tsx`, `disclosure.tsx` (`defaultOpen`, `forceOpen`, `id`), `filter-tabs.tsx` (variantes
       `rubriques` et `filtres`, compteur, ton d'alerte, zéro grisé, onglet actif ramené dans la zone visible, fondu de
       bord), `pagination.tsx`, `copy-button.tsx`, `search-field.tsx` (GET vers l'adresse de la page, `type="search"`,
       `name="q"`, bouton « Rechercher », lien d'effacement, autres paramètres conservés), `switch-row.tsx`
       (`hintOn` / `hintOff`), `confirm-dialog.tsx` (titre, conséquence, bouton verbe + objet, ton `danger` ou
       `primary`, `loading`, bouton « Retour ») ;
     - `dialog.tsx` : `DialogFooter` (« Retour » puis l'action ; empilés sous 640 px, action en haut ; variante
       `sticky`) ;
     - `badge.tsx` 12 px ; mention « optionnel » de `Field` 12 px.
  6. **`lib/wording.ts`** (module pur, ni « use client » ni « server-only ») et son test : `plural` ; `orgWords(model)`
     (« votre flotte » / « votre centrale », « la flotte » / « la centrale », « de votre flotte » / « de votre
     centrale ») ; libellés et tons : statuts de notification, erreurs de notification connues (`NO_PUSH_TOKEN` et les
     autres codes écrits par `apps/worker/src/push`), gravité et auteur d'audit, niveaux d'événement de dispatch,
     statuts d'abonnement Stripe, statuts de facture (§ 4), `auditActionLabel(code)` (première table, complétée en R6).
     Code inconnu → repli lisible, jamais d'exception.
  7. **404 dans les espaces connectés** : `app/dashboard/not-found.tsx` et `app/admin/not-found.tsx`, rendues dans la
     mise en page (barre gardée), **sans `<main>`** (la coquille le porte), h1 « Page introuvable », « Cette page
     n'existe pas ou plus. », boutons « Page précédente » (`NotFoundBack`) et « Retour au tableau de bord »
     (`/dashboard`) / « Retour à la vue d'ensemble » (`/admin`), `metadata.title` « Page introuvable ».
     `app/not-found.tsx` (neutre, mini-sites) ne change pas.
  8. **`dashboard-links.test.ts`** : `app/admin`, `components/admin` et `components/platform-fees/admin-*` ne sont plus
     exclus ; second contrôle sur le même périmètre : tout lien `target="_blank"` contient `NewTabHint` ou un
     `aria-label` qui dit « nouvel onglet ».
- **Critères d'acceptation** :
  1. 1440×900, bandeau cookies ouvert : toutes les entrées du super admin (dont « Sécurité & audit » et la pastille de
     « Suppressions de comptes ») et, pour les profils flotte, centrale et dispatcher, « Réglages » ont leur rectangle
     entier dans la fenêtre, menu non défilé. 1366×768, bandeau fermé : idem pour les menus clients.
  2. 390×844, tiroir ouvert : toutes les entrées atteignables en faisant défiler une seule zone ; chaque entrée ≥ 44 px ;
     les 8 liens légaux présents.
  3. Compte à une organisation : ni chevron ni menu « Organisations » ; compte à plusieurs : sélecteur inchangé.
  4. Menu standard : sections « Au quotidien », « Gestion » (+ « Plateforme ») ; le dispatcher ne voit ni « API & site
     web » ni « Mini-site » (pages accessibles par leur adresse, en lecture seule) ; tests Flotte Privée de
     `dashboard-nav.test.ts` inchangés et verts ; nouveaux tests : menu du dispatcher, `badgeLabel` de « Courses ».
  5. Aucun sur-titre affiché ; `grep -rnE 'text-\[(10|10\.5|11|11\.5)px\]' apps/web/components/ui apps/web/components/shell`
     ne renvoie rien.
  6. Fiche admin d'une Flotte Privée à 390 px : `document.documentElement.scrollWidth <= 390` ; le titre de la carte
     Flotte Privée n'est plus coupé mot à mot.
  7. `dashboard-links.test.ts` couvre l'admin (préchargement et nouvel onglet) et passe ; `cookie-notice.test.ts`,
     `legal-pages.test.ts`, `not-found-page.test.ts` passent sans modification.
  8. `wording.test.ts` (chaque table, repli d'un code inconnu) et `segment-not-found.test.ts` (textes, liens, aucun
     `<main`) passent.
  9. Aucune couleur en dur dans les fichiers nouveaux (`grep -nE '#[0-9a-fA-F]{3,8}\b'` vide) ; aucune nouvelle clé de
     stockage.
- **Contrôles** : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/web build` ; les `grep` ci-dessus ; mesure du
  menu (§ 9.3) pour les 5 profils à 1440×900, 1366×768 et 390×844 ; recette `s2-activate` et `s10-smoke-standard`
  (barre `aside`, « Menu principal », `aside a[title]`, « Propriétaire » visible).

---

### R2 — Super admin : menu, pages regroupées et « Supervision »

- **Objectif** : un menu admin en quatre groupes métier sans entrée cachée ; chaque chose sur sa page (signalements,
  diagnostic des e-mails, réglages de la plateforme) ; les journaux techniques réunis sous « Supervision ».
- **Chemins autorisés** : `apps/web/components/shell/admin-shell.tsx` ; `apps/web/app/admin/layout.tsx` (mêmes
  lectures) ; `apps/web/app/admin/signalements/page.tsx` (nouveau) ; `apps/web/components/admin/fraud-reports.tsx` ;
  `apps/web/components/admin/fraud-data.ts` (nouveau, server-only : colonnes et lecture extraites de
  `app/admin/centrales/page.tsx`) ; `apps/web/app/admin/centrales/page.tsx` (retrait de la section des signalements,
  titre et `metadata`) ; `apps/web/app/admin/actions.ts` (ajout de `revalidatePath("/admin/signalements")` à
  `platformBanReport`, `dismissFraudReport` et `liftPlatformBan`, rien d'autre) ; `apps/web/app/admin/emails/page.tsx` (nouveau) ;
  `apps/web/app/admin/contacts/page.tsx` ; `apps/web/components/admin/contact-tools.tsx` ;
  `apps/web/app/admin/contacts/actions.ts` (ajout de `revalidatePath("/admin/emails")` aux actions d'e-mail, rien
  d'autre) ; `apps/web/app/admin/reglages/page.tsx` (nouveau) ; `apps/web/app/admin/frais/page.tsx` (retrait des cartes
  « Coordonnées de paiement » et « WhatsApp », titre et `metadata`) ; `apps/web/app/admin/plans/page.tsx` (retrait de
  l'interrupteur des mini-sites) ; `apps/web/app/admin/frais/actions.ts` et `apps/web/app/admin/plans/actions.ts` (ajout
  de `revalidatePath("/admin/reglages")`, rien d'autre) ; `apps/web/components/platform-fees/admin-billing.tsx`,
  `apps/web/components/platform-fees/admin-whatsapp.tsx`, `apps/web/components/admin/booking-sites-switch.tsx`
  (textes) ; `apps/web/components/admin/supervision-tabs.tsx` (nouveau) ; en-têtes de
  `apps/web/app/admin/dispatch/page.tsx`, `apps/web/app/admin/notifications/page.tsx`,
  `apps/web/app/admin/audit/page.tsx` (ajout des onglets) ; `apps/web/app/admin/organizations/page.tsx` (titre et
  `metadata`) ; `apps/web/components/admin/admin-pages.test.ts` (nouveau).
- **Changements** :
  1. **Menu** (ordre exact) :

     | Section | Entrée | Adresse | Pastille (`aria-label`) |
     |---|---|---|---|
     | Pilotage | Vue d'ensemble | `/admin` (exact) | — |
     | | Carte en direct | `/admin/carte` | — |
     | Clients | Clients | `/admin/organizations` | — |
     | | Demandes de contact | `/admin/contacts` | lime : « N nouvelle(s) demande(s) de contact » |
     | | Signalements de fraude | `/admin/signalements` | rouge : « N signalement(s) de fraude à examiner » |
     | | Réseau partagé | `/admin/reseau` | ambre : « N organisation(s) à valider pour le réseau partagé » |
     | Argent | Frais Rydar | `/admin/frais` | ambre : « N élément(s) à confirmer (paiements, baisses de frais) » |
     | | Commissions des centrales | `/admin/centrales` | — |
     | | Offres & limites | `/admin/plans` | — |
     | Plateforme | Réglages de la plateforme | `/admin/reglages` | — |
     | | Informations légales | `/admin/legal` | — |
     | | Suppressions de comptes | `/admin/suppressions` | rouge : « N suppression(s) de compte en échec ou en retard » |
     | | Supervision | `/admin/dispatch` (`match` : `/admin/notifications`, `/admin/emails`, `/admin/audit`) | — |
     | Mon espace | nom de la centrale ou « Mes centrales » | `/dashboard` | — (inchangé) |

  2. **Supervision** : `SupervisionTabs` (`FilterTabs` « rubriques ») : Dispatch & erreurs, Notifications, E-mails,
     Sécurité & audit, dans l'en-tête des 4 pages ; leurs h1 ne changent pas.
  3. **`/admin/signalements`** « Signalements de fraude » (« Chauffeurs signalés par les centrales : bannir de toute la
     plateforme ou classer sans suite. ») : même lecture, même `FraudReportsList`, mêmes actions et mêmes cases à cocher
     de bannissement ; « Classer » → « Classer sans suite » ; « Connexion bloquée au niveau du compte (Auth) » →
     « Connexion bloquée (identifiants du chauffeur) » ; état vide compact. La section quitte `/admin/centrales`.
  4. **`/admin/emails`** « E-mails » : la carte « Envoi des e-mails » de `/admin/contacts` déplacée avec son
     `MailQueueRefresh` (état du service et du serveur mail, derniers e-mails, échecs, relance, envoi de test) ; commandes
     et chemins (`docker compose …`, `/var/log/mail.log`, `127.0.0.1:25`, `deploy/update-production.sh`) dans un
     `Disclosure` « Détails techniques (à transmettre à votre technicien) ». `/admin/contacts` devient une boîte de
     réception pleine largeur et n'affiche, quand le service est arrêté, le serveur mail injoignable ou des e-mails en
     échec, qu'un `Callout` « Les e-mails ne partent pas » + lien « Voir Supervision › E-mails » (mêmes lectures d'état).
  5. **`/admin/reglages`** « Réglages de la plateforme » (« Coordonnées de paiement de Rydar, WhatsApp de Rydar et
     interrupteur des mini-sites. ») : `BillingCard` et la carte WhatsApp de Rydar (mêmes lectures que `/admin/frais` :
     `admin_platform_overview` pour `billing`, `platform_whatsapp` sans jeton), `BookingSitesSwitchCard` (mêmes lectures
     que `/admin/plans`). Elles quittent `/admin/frais` et `/admin/plans`.
  6. **Titres alignés sur le menu** : `/admin/organizations` « Clients », `/admin/frais` « Frais Rydar »,
     `/admin/centrales` « Commissions des centrales » (titre et `metadata` seulement ; le contenu en R3 et R5).
  7. **Test statique** `admin-pages.test.ts` : chaque `app/admin/**/page.tsx` appelle `requireSuperAdmin()` avant
     toute lecture (`.from(`, `.rpc(`, `createAdminClient(`).
- **Critères d'acceptation** :
  1. Menu conforme au tableau (libellés, ordre, adresses, pastilles et leurs `aria-label`) ; pastilles calculées par les
     mêmes requêtes qu'avant.
  2. 1440×900 bandeau ouvert et 1366×768 bandeau fermé : toutes les entrées admin visibles sans défiler le menu (hors
     section « Mon espace », présente seulement pour un super admin aussi membre d'une centrale).
  3. « Supervision » porte `aria-current="page"` sur ses 4 pages, l'onglet actif aussi.
  4. Bannir (cases cochées), lever, classer sans suite marchent depuis `/admin/signalements` ; la page et la pastille se
     mettent à jour.
  5. Mailer local arrêté : `Callout` sur `/admin/contacts`, état détaillé sur `/admin/emails` ; relance et envoi de test
     marchent depuis `/admin/emails`.
  6. Coordonnées de paiement, WhatsApp de Rydar et interrupteur des mini-sites s'enregistrent depuis `/admin/reglages`
     (valeurs relues ensuite) et n'apparaissent plus sur `/admin/frais` ni `/admin/plans`.
  7. `admin-pages.test.ts` passe ; aucun « tenant » ni « rattacheur » visible dans la coquille et les nouvelles pages.
- **Contrôles** : minimaux (§ 8.0) ; captures super admin (menu 1440/1366/390, signalements, e-mails, réglages,
  contacts) ; débordement à 390 sur ces pages.

---

### R3 — Super admin : accueil « À traiter » et liste des clients

- **Objectif** : le propriétaire voit d'abord ce qu'il doit faire aujourd'hui ; la liste des clients se filtre, se
  cherche et se lit sur téléphone ; un seul bouton de création.
- **Chemins autorisés** : `apps/web/app/admin/page.tsx` ; `apps/web/app/admin/layout.tsx` ;
  `apps/web/components/admin/platform-data.ts` ; `apps/web/components/admin/admin-todo.ts` et `admin-todo.test.ts`
  (nouveaux) ; `apps/web/components/admin/headcount.tsx` ; `apps/web/app/admin/organizations/page.tsx` ;
  `apps/web/components/admin/new-client.tsx` (nouveau) ; `apps/web/components/admin/admin-widgets.tsx`
  (`CreateOrganizationSheet` seulement) ; `apps/web/components/admin/private-fleet.tsx` (`CreatePrivateFleetSheet` :
  ouverture pilotée et mise en page du formulaire seulement).
- **Changements — accueil** :
  1. `getAdminTodo(supabase)` dans `platform-data.ts`, enveloppée dans `cache()` de React : les 6 lectures actuelles du
     layout (signalements ouverts, paiements « declared », baisses « pending », suppressions failed + stalled, demandes
     « new », réseau à valider), chaque compte `number | null` (null = lecture impossible). Le layout s'en sert pour les
     pastilles (null → pas de pastille, comme aujourd'hui) et l'accueil pour « À traiter » : une seule source.
  2. `adminTodoItems(todo, legal)` (pur, testé) : une ligne par élément non nul, verbe + nombre + lien :
     « Confirmer N paiement(s) déclaré(s) » → `/admin/frais#a-traiter` ; « Décider N baisse(s) de frais » →
     `/admin/frais#a-traiter` ; « Examiner N signalement(s) de fraude » → `/admin/signalements` ; « Répondre à N
     demande(s) de contact » → `/admin/contacts` ; « Valider N organisation(s) pour le réseau partagé » →
     `/admin/reseau#a-valider` ; « Vérifier N suppression(s) de compte en échec » → `/admin/suppressions` ;
     « Compléter les informations légales de l'éditeur » (l'encadré actuel : éditeur incomplet ou mentions manquantes) →
     `/admin/legal`. Compte null → « Lecture impossible : … » ; rien → « Rien à traiter, tout est à jour. ».
  3. Ordre : carte « À traiter » ; 4 `StatCard` : « Chauffeurs en ligne » (« 20 / 29 », lien `/admin/carte`),
     « Courses aujourd'hui » (« dont N en cours »), « Volume du mois », « Abonnements par mois » ; ligne « Santé » de
     liens compacts : « N course(s) sans chauffeur (24 h) » → `/admin/dispatch`, « N notification(s) en échec
     (24 h) » → `/admin/notifications`, « N alerte(s) de sécurité (7 j) » → `/admin/audit?severity=security` (rouge ou
     ambre seulement au-dessus de zéro).
  4. Un seul tableau « Clients » (fusion des deux tableaux actuels) : Client (nom + badge Flotte / Centrale à
     commission / Flotte Privée ; candidatures en petite note ambre), Statut, Chauffeurs (actifs · en ligne), Courses
     (aujourd'hui · 30 j), Sans chauffeur 7 j, Dernière course ; cartes sous `md`. Données déjà lues
     (`getPlatformHeadcount`, `platform_overview`) ; `private_fleet` ajouté à la sélection des organisations de
     `platform-data.ts` (colonne déjà lue par la liste des clients).
  5. « Effectifs détaillés » (`HeadcountCards`) dans un `Disclosure` fermé ; en bas, le graphique (inchangé) et
     « Alertes récentes » limitées à 5 lignes + « Tout voir » → `/admin/dispatch`.
  6. En-tête : « Vue d'ensemble », « Ce qui demande votre attention, puis l'activité de vos clients. », action « Carte
     en direct ».
- **Changements — liste des clients** :
  1. Description « Vos clients : flottes, centrales et chauffeurs Flotte Privée. ».
  2. Un seul bouton principal « Nouveau client » → fenêtre « Quel type de client ? » : « Flotte », « Centrale à
     commission » (descriptions de `DISPATCH_MODEL_META`), « Flotte Privée » (« Un chauffeur seul, avec son propre site
     de réservation » ; nom accessible du bouton : « Nouveau client Flotte Privée »). Les deux premiers ouvrent
     `CreateOrganizationSheet` avec `initialModel`, le troisième `CreatePrivateFleetSheet` (`open` / `onOpenChange`) ;
     formulaires, noms de champs, `fieldErrors` et actions inchangés ; la passerelle de `/admin/contacts/[id]`
     (formulaire prérempli) marche toujours.
  3. `CreateOrganizationSheet` : « Nom commercial », « Identifiant » (aide « adresse : {identifiant}.{domaine} » avec
     `env.rootDomain`, plus de `rydar.app` en dur), « E-mail de contact » ; texte des frais en une ligne + « En savoir
     plus » replié ; mot de passe provisoire derrière la case « Définir un mot de passe provisoire (serveur sans
     e-mail) » (case décochée = champ vide = invitation, comme aujourd'hui) ; « Client créé ».
  4. `CreatePrivateFleetSheet` : sections numérotées (1 Client, 2 Chauffeur et véhicule, 3 Offre et frais, 4 Accès et
     contrat) ; raison sociale, SIRET et n° d'inscription au registre VTC dans un `Disclosure` « Informations légales
     (facultatif) » ouvert d'office si l'un d'eux a une erreur ; libellés inchangés.
  5. Filtres (`FilterTabs` « filtres », `?type=`) avec compteurs : Tous, Flottes (`flottes`), Centrales (`centrales`),
     Flotte Privée (`flotte-privee`, clé actuelle), Suspendus et archivés (`inactifs`) ; une seule lecture des
     organisations, filtrage et comptage en TypeScript.
  6. Recherche `?q=` (`SearchField`) sur nom, ville, e-mail et identifiant, en TypeScript sur la liste lue (casse et
     accents ignorés) ; aucune requête `ilike`.
  7. Colonnes : Client (nom, ville ; identifiant en petit), Type, Offre, Contact, Créé le, Statut ; cartes sous `md` ;
     filtre vide « Aucun client dans ce filtre » + « Voir tous les clients ».
- **Critères d'acceptation** :
  1. Pastilles et lignes « À traiter » identiques (même fonction) ; une lecture en échec affiche « Lecture
     impossible », jamais 0 ; `admin-todo.test.ts` (chaque élément, pluriels, null, liste vide) passe.
  2. Accueil sans « MRR », « push », « tenant » ni « rattacheur » ; hauteur ≤ 2 200 px à 390 et ≤ 1 700 px à 1440
     (annexe A).
  3. Liste : compteurs justes (la somme des types égale « Tous ») ; recherche par nom, ville, e-mail ;
     `?type=flotte-privee` toujours valable ; aucune colonne hors écran à 390.
  4. Les 3 types se créent par « Nouveau client » ; `s1-create` adapté passe.
- **Contrôles** : minimaux ; captures accueil et liste ; recette `s1-create` et `refonte/photo/fp-setup.mjs` (cliquer
  « Nouveau client » puis « Nouveau client Flotte Privée », ouvrir « Informations légales (facultatif) »).

---

### R4 — Super admin : fiche d'un client

- **Objectif** : résumé d'abord, l'accès et l'argent ensuite, les réglages rares repliés, les actions graves en bas ;
  mêmes composants, mêmes actions, mêmes confirmations.
- **Chemins autorisés** : `apps/web/app/admin/organizations/[id]/page.tsx` ;
  `apps/web/components/admin/dispatch-model.tsx` ; `apps/web/components/admin/private-fleet-card.tsx` ;
  `apps/web/components/admin/private-fleet-state.ts` (aides d'affichage) ; `apps/web/components/admin/admin-widgets.tsx` (`OrganizationStatusActions`, `OrganizationPlanForm`) ;
  `apps/web/components/admin/organization-access.tsx` ; `apps/web/components/admin/org-network-card.tsx` ;
  `apps/web/components/platform-fees/admin-org-fees-card.tsx` (libellés) ; `apps/web/components/admin/org-watch.ts` et
  `org-watch.test.ts` (nouveaux).
- **Changements** (ordre de la page) :
  1. **En-tête** (`PageHeader`) : « ← Clients » ; nom ; badges statut + **un seul** badge de type (Flotte, Centrale à
     commission ou Flotte Privée ; plus de `DISPATCH_MODEL_META.short`) ; ligne `meta` : e-mail · ville · identifiant
     (slug, en dernier) (+ motif de suspension s'il y en a) ; seule action d'en-tête : « Réactiver » (client suspendu ou
     archivé).
  2. **« À surveiller »** (`Callout`, seulement s'il y a quelque chose ; `orgWatchItems`, pur et testé) : CGV non
     acceptées ou mise à jour à accepter ; frais en retard (lien vers `/admin/frais/[id]`) ; invitation en attente ;
     hausse programmée (date) ; candidatures en attente.
  3. **Chiffres** : En ligne (x / y), Courses aujourd'hui (semaine en dessous), Chiffre d'affaires du jour, Sans
     chauffeur aujourd'hui ; Flotte Privée : Courses et Chiffre d'affaires seulement. Carte « Clés API » et sa lecture
     retirées.
  4. **Flotte Privée** : `PrivateFleetCard` (état du client, clé du site, recréer la fiche, renvoyer l'accès) reste en
     tête, **sans** les boutons de bascule dans son en-tête (ils vont au point 8).
  5. **Accès** (`OrganizationAccessCard`, absent en Flotte Privée) : « Donner un accès » ouvre sur **« Invitation par
     e-mail »** ; le mot de passe provisoire devient une case « Mot de passe provisoire (serveur sans e-mail) » et son
     champ un `Field` au libellé visible ; charge envoyée identique.
  6. **Argent** : `OrgPlatformFeesCard` (si frais) puis carte « Modèle et frais Rydar » : ligne de résumé (« Modèle :
     Flotte · Frais : 5 € par course · CGV acceptées le 2 octobre 2026 · hausse programmée le … ») et bouton
     « Modifier le modèle ou les frais » qui déplie `DispatchModelForm` **inchangé** (mêmes propriétés, même `key` de
     remontage, mêmes confirmations, `router.refresh`). Dans le formulaire : plus de « Option 1 / Option 2 » ; règles
     des frais dans un `Disclosure` « Règles des frais » ; Flotte Privée (`modelLocked`) : une ligne « Modèle : flotte
     (imposé par la Flotte Privée) » à la place du choix grisé.
  7. **Offre et limites** (`OrganizationPlanForm`) : résumé (« Offre Pro · 40 chauffeurs · 3 000 courses par mois ·
     API, mini-site, statistiques avancées », limites effectives par `effectiveLimits`) + « Abonnement : Actif /
     Période d'essai jusqu'au … / sans abonnement en ligne » (lexique) ; `Disclosure` « Ajuster une limite pour ce
     client (facultatif) » : nombres avec l'aide « Selon l'offre : 40 » (ou « illimité ») ; options à trois choix
     « Selon l'offre (oui) » / « Forcer : oui » / « Forcer : non » — « Selon l'offre » supprime la clé de la surcharge,
     même structure envoyée qu'aujourd'hui ; Flotte Privée : « Chauffeurs max. » et « Administrateurs » désactivés,
     aide « Imposé : 1 (Flotte Privée) ».
  8. **« Offre de service et réseau partagé »** (`Disclosure` fermé) : organisation standard → `PrivateFleetEntryCard`,
     bouton « Passer en Flotte Privée » en `outline` (plus en lime) ; Flotte Privée → « Passer en flotte standard » et
     « Passer en centrale » (même dialogue) ; carte du réseau partagé (hors Flotte Privée), mêmes conditions d'affichage.
  9. **« Activité »** (`Disclosure` fermé) : chauffeurs connectés, erreurs de dispatch (7 j), notifications (statuts et
     erreurs traduits, code brut dans le détail), lien d'inscription (état, candidatures, bannis).
  10. **« Zone sensible »** en bas : « Suspendre » et « Archiver » (dialogues inchangés) selon le statut.
- **Critères d'acceptation** :
  1. Ordre conforme pour une flotte, une centrale et une Flotte Privée (captures) ; aucune action perdue : Réactiver,
     Suspendre, Archiver, Donner / révoquer / renvoyer un accès, modèle et frais (enregistrer, programmer, appliquer,
     annuler une hausse), actions des frais, offre et limites, clé du site (créer, révoquer), recréer la fiche, bascules,
     réseau partagé.
  2. Plus aucun `failed`, `queued`, `cancelled`, `NO_PUSH_TOKEN`, `ride_offer_scheduled`, `trialing`, `active`,
     « Option 1 », « Rattacheur » dans le texte visible (détails fermés).
  3. 390 px sans débordement ; hauteurs ≤ 3 000 (flotte Élite), 3 300 (centrale Express), 3 600 (Flotte Privée
     Lambert) px à 390 (annexe A).
  4. `org-watch.test.ts` passe ; `web2-texts.test.ts` passe (mots interdits) ; `private-fleet-admin.test.ts` inchangé.
  5. `s3-keys`, `s8-switch`, `s9-return` adaptés passent.
- **Contrôles** : minimaux ; captures des 3 fiches et de leurs fenêtres ; recette `s3-keys` (« Nouvelle clé », « Clé
  navigateur » / « Clé serveur », « Nom », « Adresses du site », « Générer la clé », « J'ai copié la clé » : noms
  gardés), `s8-switch` (ouvrir « Offre de service et réseau partagé » avant « Passer en flotte standard » ; ouvrir
  « Modifier le modèle ou les frais » avant le `radiogroup` « Modèle d'exploitation » ; viser le « Enregistrer » de
  cette carte), `s9-return` (ouvrir le repli avant « Passer en Flotte Privée »).

---

### R5 — Super admin : argent (Frais Rydar, commissions des centrales, offres)

- **Objectif** : l'argent d'abord ; la mécanique des frais repliée ; pas de doublon entre Frais Rydar et Commissions des
  centrales ; une page des offres seule.
- **Chemins autorisés** : `apps/web/app/admin/frais/page.tsx` ; `apps/web/app/admin/frais/[orgId]/page.tsx` ;
  `apps/web/components/platform-fees/admin-platform-sections.tsx`, `admin-account-actions.tsx` (repli de
  `TermsForm`), `admin-platform-metric.tsx`, `admin-platform-format.ts` et son test, `admin-platform-dialogs.tsx`
  (libellés) ; `apps/web/app/admin/centrales/page.tsx` ; `apps/web/app/admin/plans/page.tsx` ;
  `apps/web/components/admin/admin-widgets.tsx` (`PlanEditor` seulement).
- **Changements** :
  1. **`/admin/frais`** : description « Ce que vos clients doivent à Rydar : paiements à confirmer, retards et
     encaissements. » ; 4 indicateurs visibles (À recevoir, En retard, À confirmer, Reçu ce mois), les 4 autres dans
     « Plus de chiffres » ; ordre : « À traiter » (`#a-traiter`), tableau, `Disclosure` « Comment sont calculés les
     frais ? » (8 règles, texte inchangé) ; en-tête de colonne « Client » ; erreur de lecture → phrase (message brut
     journalisé) ; `PlatformLive` gardé.
  2. **`/admin/frais/[orgId]`** : `PageHeader` (« ← Frais Rydar », badge de type par `.label`) ; relevé : 15 premières
     écritures, puis `Disclosure` « Afficher les N autres » (mois et export CSV inchangés) ; « Conditions » → ligne de
     résumé (« Mensuel · 5 jours · blocage désactivé ») + « Modifier les conditions » qui déplie `TermsForm` inchangé
     (texte juridique compris) ; flotte : lignes à zéro propres aux centrales masquées dans `OriginBreakdown`
     (« Encore chez les chauffeurs », « Annulé par la centrale ») ; compte sans frais ni historique (taux 0 ; écrit,
     reçu, déclaré à 0) : état vide « Aucun frais Rydar pour ce client — réglez-les depuis sa fiche » + lien, les
     actions restant accessibles ; erreur → phrase.
  3. **`/admin/centrales`** « Commissions des centrales » (« Activité des centrales à commission : courses,
     commissions et sommes dues par les chauffeurs. ») : 4 indicateurs (Centrales et candidatures, Courses du mois,
     Volume et commissions, Dû par les chauffeurs) ; « Dû à Rydar » = carte-lien vers `/admin/frais` ; indicateur et
     colonne « Frais plateforme » retirés ; cartes sous `md` ; mois en `FilterTabs` (`aria-current`) ; `monthKey`,
     `monthLabel`, `lastMonths` repris de `admin-platform-format.ts`, lui-même réécrit avec `dateTimeFormat` (sorties
     identiques, son test passe sans changement de valeurs attendues) ; même remplacement dans
     `admin-account-actions.tsx` (date du jour).
  4. **`/admin/plans`** : description « Ce que comprend chaque abonnement. » ; code technique masqué des cartes ;
     « 1 client » / « N clients » ; fenêtre de l'offre dans l'ordre Nom, Description, Prix mensuel, Prix annuel ;
     Limites (Chauffeurs max., Courses par mois, Administrateurs max., Historique en jours — aide « vide = illimité »
     sur les quatre) ; Options aux libellés des cartes (API de réservation, Mini-site, Domaine personnalisé,
     Statistiques avancées) ; Visibilité ; puis « Code » (visible, en dernier) et « Points forts affichés (1 par
     ligne) » ; attributs `name=` inchangés.
- **Critères d'acceptation** :
  1. Plus de « Frais plateforme », « rattacheur », « Option 2 » dans le texte visible des fichiers du lot ; `grep -n
     "new Intl\." apps/web/app/admin/centrales/page.tsx apps/web/components/platform-fees/admin-platform-format.ts
     apps/web/components/platform-fees/admin-account-actions.tsx` vide.
  2. `admin-platform-format.test.ts` passe (mêmes sorties) ; export CSV et factures inchangés (routes non touchées).
  3. Hauteurs à 390 : `/admin/frais` ≤ 3 000 px, compte Express ≤ 4 500 px (annexe A) ; aucun débordement.
  4. Créer et modifier une offre marche (mêmes champs envoyés).
- **Contrôles** : minimaux ; captures des 4 pages et de la fenêtre d'offre ; export CSV du compte Express ouvert et
  comparé (mêmes lignes qu'avant).

---

### R6 — Super admin : supervision et pages annexes

- **Objectif** : des journaux techniques lisibles par un non-technicien, sur téléphone aussi ; les pages annexes
  propres.
- **Chemins autorisés** : `apps/web/app/admin/dispatch/page.tsx`, `apps/web/app/admin/notifications/page.tsx`,
  `apps/web/app/admin/audit/page.tsx`, `apps/web/app/admin/emails/page.tsx` ; `apps/web/app/admin/reseau/page.tsx`,
  `apps/web/components/admin/network-admin.tsx` ; `apps/web/app/admin/legal/page.tsx`,
  `apps/web/components/admin/legal-form.tsx`, `apps/web/components/admin/org-terms-notify.tsx` (textes) ;
  `apps/web/components/admin/live-console.tsx` (libellé d'un bouton) ; `apps/web/app/admin/suppressions/page.tsx`,
  `apps/web/app/admin/suppressions/deletion-tools.tsx` (mise en page, textes) ; `apps/web/app/admin/contacts/page.tsx`,
  `apps/web/app/admin/contacts/[id]/page.tsx` (en-tête, cartes sous `md`) ; `apps/web/lib/wording.ts` et son test.
- **Changements** :
  1. **Dispatch & erreurs** : « Toutes les organisations — 7 derniers jours. » ; filtre « Erreurs seulement »
     (`?niveau=erreurs`) ; messages identiques consécutifs regroupés (même organisation, même type, même message →
     « Plus de position GPS de Julien × 6 », heure du dernier) ; niveaux en français ; police normale ; lignes empilées
     sous `md` (date · organisation · niveau sur une ligne secondaire), grille à partir de `md` ; « Courses sans
     chauffeur » avec `VEHICLE_CATEGORY_META`.
  2. **Notifications** : « Notifications envoyées sur les téléphones des chauffeurs (24 dernières heures). » ;
     indicateurs « Envoyées », « En attente d'envoi », « Échecs », « Annulées » (« course prise par un autre
     chauffeur ») ; statuts et erreurs en français, code brut dans un détail replié ; 50 lignes par page
     (`Pagination`) ; lignes empilées sous `md`.
  3. **Sécurité & audit** : « Actions sensibles tracées : créations, suspensions, clés du site, accès refusés. » ; vue
     par défaut « Actions des personnes » = toutes les lignes **sauf** celles du système de gravité « Info » ; filtres
     « Alertes de sécurité » (existant) et « Tout (détail technique) » ; filtre par client (`?client=`) ; gravité, auteur
     et action en français (`auditActionLabel` complété avec les codes écrits par `apps/web` et par les migrations,
     repli sur le code) ; IP, entité et métadonnées dans un détail replié par ligne ; 50 lignes par page ; lignes
     empilées sous `md`.
  4. **E-mails** : statuts et textes en français (contenu déplacé en R2).
  5. **Réseau partagé** (fermé et sans aucune ligne) : interrupteur et convention, puis une ligne « Rien à suivre tant
     que le réseau est fermé. » à la place des 4 cartes vides ; `NETWORK_POSITIONING` dans un `Disclosure` « Ce que
     fait le réseau partagé » (texte inchangé) ; « Changée avec son texte, par migration : … » → « Mise à jour par
     l'équipe technique ; une correction du juriste donne une nouvelle version avec un délai de grâce. » ; badges par
     `.label` ; cartes sous `md`.
  6. **Informations légales** : versions affichées avec `legalDateLabel` (« 2 octobre 2026 ») ; « Repoussez d'abord la
     date (ORG_LEGAL_EFFECTIVE_AT, @rydar/shared, …) puis redéployez » → « Demandez à votre équipe technique de
     repousser la date d'entrée en vigueur au … au plus tôt. ».
  7. **Carte en direct** : libellé visible « Noms » à côté de l'icône du bouton « Noms des chauffeurs » (nom accessible
     et `aria-pressed` gardés).
  8. **Suppressions, Demandes de contact** : en-têtes `PageHeader` (fiche : « ← Demandes de contact »), cartes sous
     `md`, textes du lexique.
- **Critères d'acceptation** :
  1. Texte visible (détails fermés) sans `warning`, `critical`, `super_admin`, `system`, `queued`, `failed`,
     `NO_PUSH_TOKEN`, `api_keys.insert`, `DBG`, « tenant », « inter-tenant », « outbox », « worker », « FCM » (recherche
     sensible à la casse : « Info » et « Système » sont les libellés français).
  2. Aucune entrée « Attention » ou « Critique » masquée par la vue par défaut de l'audit (contrôle sur la base de
     recette : compter les lignes `warning`/`critical` des 50 dernières, toutes présentes).
  3. 390 px sans débordement sur ces 8 pages ; audit à 1440 ≤ 3 000 px (avant 7 394) ; réseau fermé à 390 ≤ 1 400 px.
  4. `web2-texts.test.ts`, `network-terms.test.ts` passent ; `wording.test.ts` couvre les nouvelles actions.
- **Contrôles** : minimaux ; captures ; contrôle du point 2 par une requête SQL de recette (lecture seule).

---

### R7 — Clients : En direct, courses et journal du dispatch

- **Objectif** : l'écran temps réel lisible sur portable et téléphone ; des listes de courses lisibles ; des mots et des
  étapes justes ; un journal compréhensible par défaut.
- **Chemins autorisés** : `apps/web/components/command/**` ; `apps/web/components/platform-fees/org-platform-banner.tsx`
  (position seulement) ; `apps/web/app/dashboard/rides/page.tsx`, `apps/web/app/dashboard/rides/[id]/page.tsx` ;
  `apps/web/components/rides/**` ; `apps/web/components/dispatch/dispatch-journal.tsx`,
  `apps/web/app/dashboard/dispatch/page.tsx` ; `apps/web/components/alerts/dispatch-alerts.tsx` (libellés) ;
  `apps/web/lib/places.ts` ; `packages/shared/src/domain.ts` (`RIDE_FILTERS` : libellés et ordre ;
  `RIDE_SOURCE_LABELS` ; `RIDE_TYPE_LABELS` — rien d'autre) ; `apps/web/components/rides/assignable.ts` et
  `assignable.test.ts` (nouveaux) ; `apps/web/components/rides/timeline-labels.ts` et son test (nouveaux).
- **Changements** :
  1. **En direct** : onglet « Alertes » → « À traiter » (même contenu) ; ligne de course : « {libellé de l'alerte} · il y
     a 12 min » (message complet en `title` et dans le panneau) ; panneau Flotte : « vu il y a 46 min » ; sous 1400 px,
     ligne de chiffres compacte dans l'en-tête du panneau des courses (« 17 courses · 964 € · 10 / 14 en ligne · 2 en
     recherche », mêmes `state.kpis`) ; sous `xl`, segment « Chauffeurs (N) » qui affiche `FleetPanel` dans le
     panneau ; bandeau des frais flottant seulement à partir de `lg`, dans le flux au-dessus de la carte en dessous
     (contenu et conditions inchangés) ; outils de la carte : « Signalements » et « Recentrer » visibles, « Noms des
     chauffeurs », « Chauffeurs hors ligne » et « Carte claire / sombre » dans un panneau « Affichage » d'interrupteurs
     libellés (mêmes clés `rydar.mapTheme`, `rydar.mapReports`, aucune nouvelle) ; `ride-focus` : « gardé par la
     centrale » selon `orgWords` (« chauffeur gardé » pour une flotte) ; `mapPadding` ajusté au téléphone.
  2. **Courses (liste)** : filtres de statut dans l'ordre Toutes · Sans chauffeur · En recherche · Proposées ·
     Attribuées · En cours · Terminées · Annulées, puis un second groupe « Type » : Immédiates · Planifiées (mêmes clés
     `?filter=`, même requête) ; filtres à zéro grisés ; sources « Saisie manuelle » / « Votre site » / « Mini-site » ;
     « Vos courses des 30 derniers jours et à venir. » ; cartes sous `md` (« #1676 · mar. 13/10 11:00 » + statut ;
     trajet ; client · catégorie · prix ; règlement en centrale ; cellule du réseau partagé) ; statut et prix sans
     coupure ; tracé (`RouteGlyph`) à partir de `xl`.
  3. **Fiche course** : « Offres envoyées » sur deux niveaux sous `sm` (nom + badge ; vague · rayon · envoi · distance ·
     réponse), plus de largeurs fixes, colonne de réponse absente quand vide, `formatNumber` (« 0,0 s ») ; « Relancer le
     dispatch » → « Relancer la recherche » (succès « Recherche relancée ») ; « Timeline » → « Chronologie » ; « Vue
     technique » → « Détails techniques » ; `RideProgress` : étape courante « Recherche d'un chauffeur » pour une course
     en recherche ou proposée, « À confirmer » pour une réservation Flotte Privée en attente ; bouton de fermeture
     « Retour » dans « Attribuer » et les autres fenêtres de `components/rides` ; carte Client sans « Aucun compte
     client : … » et sans ligne « Vol » quand « Vol suivi » est affiché ; sous `xl`, « Alertes de suivi » en tête puis la
     carte du trajet, « Répartition & règlement » et « Vol suivi » ensuite.
  4. **Chronologie dans les mots du métier** (`timeline-labels.ts`, affichage seulement) : libellé par `type`
     d'événement (`ride.created` selon la source : « Réservation reçue de votre site », « Course saisie au tableau de
     bord » / « Réservation prise par téléphone » en Flotte Privée ; `dispatch.private_offer`, `dispatch.private_self`,
     `dispatch.private_declined`, `dispatch.private_no_driver`, `dispatch.private_incompatible` en Flotte Privée : « Envoyée
     sur votre téléphone · réponse avant … », « Vous l'avez prise », « Refusée », « Non confirmée », « À vérifier :
     véhicule ») ; type inconnu → message enregistré. Les messages en base ne changent pas (webhooks, app).
  5. **Attribuer** : `assignableDrivers(drivers, ride)` (pur, testé) partagé par la fiche et l'accueil : groupes
     « Disponibles maintenant », « Occupés », « Hors ligne (N) » replié, chacun trié par distance ; champ « Nom,
     plaque » dès 8 chauffeurs ; liste vide « Aucun autre chauffeur actif » ; véhicule sur sa propre ligne au téléphone.
     Aucun chauffeur retiré ; `assignRide` et ses gardes inchangés.
  6. **Nouvelle course** : N° de vol, e-mail du client et note dans « Ajouter un vol, un e-mail ou une note » (ouvert
     d'office si départ ou arrivée est un aéroport — `isAirport` — ou si l'un de ces champs a une erreur) ; puces
     d'adresses « Orly — Terminal 4 » (sans « d' ») affichées seulement si le centre de la flotte est en Île-de-France ;
     icône `Luggage` pour les bagages ; libellés courts visibles sous 420 px ; « Créer et dispatcher » → « Créer la
     course » ; charge de `createRide` identique.
  7. **Journal du dispatch** : « Ce qui s'est passé pour chaque course : chauffeurs prévenus, refus, attributions,
     alertes. » ; mode détail coupé par défaut (`useState(false)`) ; invite `dispatch@…` retirée ; niveaux = pastille +
     mot (lexique) ; « fleet » → « Flotte » ; données JSON seulement dans « Détails techniques » ; interrupteurs détail et
     présence sous « Options avancées » ; cartes « Avertissements (24 h) » et « Échecs (24 h) » (« courses restées sans
     chauffeur », icône d'échec, rouge seulement au-dessus de zéro) ; lignes empilées sous `sm`.
  8. `dispatch-alerts.tsx` : échéance d'un document formatée par `dateTimeFormat` (plus de `new Intl` au rendu) ; carte
     « SOURCE » avec les nouveaux libellés de source.
- **Critères d'acceptation** :
  1. 390 px : Courses, fiche course, Journal, En direct sans débordement ; noms des offres lisibles ; aucune colonne
     utile hors écran.
  2. 1024 à 1399 px : chiffres du jour visibles ; sous `xl`, chauffeurs accessibles ; bandeau des frais ne recouvre ni
     « Signalements » ni « Recentrer ».
  3. `assignable.test.ts` et `timeline-labels.test.ts` passent ; `live-state.test.ts`, `ride-search.test.ts`,
     `web2-texts.test.ts` passent.
  4. Plus de « Instantanée », « Dashboard » (source), « Timeline », « Relancer le dispatch », « Créer et dispatcher »,
     « DBG », « WRN », « tenant » dans le texte visible ; liens existants `?filter=` valables.
- **Contrôles** : minimaux ; captures flotte, centrale, dispatcher (accueil, courses, filtres, fiche, Attribuer,
  Nouvelle course, Journal) à 1440, 1280, 390 ; `TEST_DATABASE_NAME=rydar_test_r7 pnpm test:db` (le titre de test
  « Relancer le dispatch » d'`analytics.test.ts` peut rester).

---

### R8 — Clients : chauffeurs, statistiques, agenda et espace Flotte Privée

- **Objectif** : des fiches et listes de chauffeurs rangées et confirmées ; des statistiques utiles même vides ; un
  agenda pensé pour le téléphone ; un espace Flotte Privée à deux actions claires par réservation.
- **Chemins autorisés** : `apps/web/app/dashboard/drivers/page.tsx`, `apps/web/app/dashboard/drivers/[id]/page.tsx` ;
  `apps/web/components/drivers/**` ; `apps/web/components/network/driver-safety.tsx` ;
  `apps/web/components/charts/stats-view.tsx`, `apps/web/app/dashboard/stats/page.tsx` ;
  `apps/web/app/dashboard/agenda/page.tsx`, `apps/web/components/agenda/**` ; `apps/web/components/private-fleet/**` ;
  `apps/web/app/dashboard/profil/page.tsx`, `apps/web/app/dashboard/site/page.tsx` ; `docs/FLOTTE-PRIVEE.md` (§ 7.3 et
  ligne d'écart au § 15.1).
- **Changements** :
  1. **Chauffeurs (liste)** : les 5 chiffres deviennent les filtres (`StatCard href` / `active`, mêmes `?filter=`), la
     rangée de puces disparaît ; carte de la flotte dans « Voir sur la carte » (`Disclosure`) ; colonne « Compte »
     retirée (badge à côté du nom seulement si le compte n'est pas actif) ; « Chiffre d'affaires (30 j) », « N courses
     proposées » ; cartes sous `md` (nom + présence ; plaque · catégorie ; terminées · chiffre d'affaires) ; filtre
     vide « Aucun chauffeur dans « … » » + « Voir tous les chauffeurs ». Fenêtre « Ajouter un chauffeur » : libellés
     inchangés.
  2. **Fiche chauffeur** : en-tête « Message », « Modifier », « Document » + menu « Plus d'actions » (Mot de passe,
     Déconnecter de ses appareils, Désactiver / Activer, Suspendre) selon le rôle ; « Déconnecter » et « Désactiver »
     passent par `ConfirmDialog` (conséquence lue dans `setDriverStatus` / `revokeDriverSessions` et la RPC, pas
     inventée) ; `runAction` et actions inchangés ; carte « Sécurité » en bas de page, colonne de bannissement
     seulement pour propriétaire et administrateur (le dispatcher ne voit plus « Réservé aux administrateurs »), textes
     de flotte par `orgWords` (plus de « commissions jamais réglées » ni « votre centrale » chez une flotte),
     bannissement et ses cases inchangés ; « Réglez la commission dans Réglages » avec lien explicite (`?tab=dispatch`
     en flotte, `?tab=centrale` en centrale) ; « passe EN LIGNE » → « se met en ligne » ; « 21,3 s » ; sur téléphone,
     10 courses d'historique puis « Afficher les 25 ».
  3. **Documents** : bouton « Ajouter » sur chaque pièce manquante ou expirée, qui ouvre la fenêtre existante avec le
     type choisi (`AddDocumentDialog` extrait de `DriverControls`, propriété `defaultType`) ; fiche `self` (Flotte
     Privée) : une phrase en tête de carte au lieu de « Exigé — déposez-le… » répété ; « Modifier ma fiche », « Ajouter
     un document » ; description de la fenêtre pour `self` (« La photo se dépose depuis l'application ; ici, vous
     enregistrez le numéro et la date d'expiration. ») ; revue de ses propres dépôts : « Confirmer » / « Retirer », sans
     l'aide « Visible par le chauffeur » (motif gardé si l'action l'exige ; charge identique).
  4. **Statistiques / Activité** : période sans course → une carte vide utile (« Pas encore de course terminée sur
     cette période » ; « réservation » en Flotte Privée) au lieu des graphiques vides ; « Pic à … » et « … en tête »
     seulement avec au moins une course ; Flotte Privée : mot « réservation » partout, cartes « Canaux » et
     « Catégories » masquées si vides ; sans l'offre avancée, une seule carte « Statistiques avancées » (« Non compris
     dans votre offre » + « Voir les offres ») ; « Chiffre d'affaires, nombre de courses et rapidité d'attribution sur
     la période. » ; « Distance au départ » en dernier ; « Courses par chauffeur » en cartes sous `md` ; plus de nom
     d'offre en dur.
  5. **Agenda** : « Vos réservations jour par jour. » (Flotte Privée) / « Vos courses jour par jour. » (autres) ; fuseau
     affiché seulement s'il diffère d'Europe/Paris ; bouton « Nouvelle réservation » dans l'en-tête en Flotte Privée
     (`NewRideButton`) ; semaine sur téléphone : jours vides consécutifs regroupés (« lun. 5 – ven. 9 : rien de
     prévu ») ; liste : « prix à fixer » au lieu de « — », trajet sur deux lignes, titre court (« 10 – 16 oct. ») ; jour
     vide : lien « Prochaine réservation : demain 08:30 » (une lecture de plus, RLS du membre) ; « réservation » en
     Flotte Privée seulement.
  6. **Accueil Flotte Privée** : cartes « À traiter » avec « Je la prends », « Refuser », « Appeler » (`BookingActions`
     gagne `cancel?: boolean`, faux sur l'accueil ; « Annuler » reste sur la fiche) ; prix absent → bouton « Fixer le
     prix » (`EditPriceButton`) ; carte « Mon site » : état, dernière réservation reçue, « Détails » (clé
     `rdk_live_…` et « Dernière utilisation » retirées de l'accueil) ; « Réservations terminées », « Prochaines
     réservations » ; sur téléphone, « À traiter » puis « Aujourd'hui » avant les chiffres.
  7. **Réservations (liste et fiche)** : cartes sous `md` (état et « Réponse avant … » en premier) ; étiquette
     « Planifiée » retirée ; « Fixer le prix » quand il n'y a pas de prix, « Modifier le prix » sinon ; fenêtres fermées
     par « Retour ».
  8. **Mon site** : liste sur deux lignes au téléphone ; carte « Clés actives » remplacée par « Dernière réservation
     reçue » ; « Dernier contact de votre site : il y a 40 min · dernière réservation : aujourd'hui à 11:04 ».
  9. **Mon profil chauffeur** : « Jamais ouverte » + aide « Connectez-vous à l'application avec les mêmes
     identifiants » ; e-mail long sans débordement.
  10. `new Intl.DateTimeFormat` au rendu → `dateTimeFormat` (`driver-earnings.tsx`, `earnings.ts`, `documents.ts`).
  11. `docs/FLOTTE-PRIVEE.md` § 7.3 : accueil (actions, carte Mon site) et fiche (« Fixer le prix ») décrits tels que
     livrés ; une ligne au § 15.1 renvoie à ce document.
- **Critères d'acceptation** :
  1. 390 px sans débordement : Chauffeurs, fiche, Statistiques, Agenda (4 vues), accueil, Réservations, fiche, Mon site,
     Mon profil ; fiche chauffeur à 390 ≤ 3 500 px (avant 4 782).
  2. « Déconnecter » et « Désactiver » demandent une confirmation ; `private-fleet-guards.test.ts` et
     `dashboard-layout.test.ts` passent sans changement ; `agenda-model.test.ts` et `agenda-views.test.ts` adaptés aux
     deux vocabulaires (aucun cas retiré) ; `first-steps.test.ts`, `queue.test.ts`, `site-status.test.ts`,
     `booking-meta.test.ts` passent.
  3. Aucun « 21.3 s », « CA 30 j », « offres » (pour courses proposées), « votre centrale » chez une flotte ; `grep -n
     "new Intl\." apps/web/components/drivers` vide.
  4. Recettes `s6-unconfirmed`, `s6b-take`, `s7-agenda-web`, `s7b-pages` (adaptée : « Fixer le prix » quand la
     réservation n'a pas de prix) et la création de chauffeur de `s8-switch` passent.
- **Contrôles** : minimaux ; captures flotte, centrale, dispatcher, Flotte Privée.

---

### R9 — Clients : argent, inscriptions, réseau partagé et messages

- **Objectif** : la tâche du jour avant le bilan ; un seul montant « à payer » des frais Rydar ; des lignes de règlement
  exactes ; les candidatures avant le lien ; un mot par chose.
- **Chemins autorisés** : `apps/web/app/dashboard/settlements/**` ;
  `apps/web/components/settlements/settlements-view.tsx`, `settlement-ui.tsx`, `split-preview.tsx`, `settlement-list.ts`
  et son test (seulement si nécessaire, contrat inchangé) ; `apps/web/components/platform-fees/org-*` (carte, bandeau,
  fenêtre de paiement, interface, format et son test, relevés, historique, contexte de paiement) ; `apps/web/components/platform-fees/pay-now.ts` et son test (nouveaux) ;
  `apps/web/app/dashboard/rydar/**` ; `apps/web/app/dashboard/network/page.tsx` ; `apps/web/components/network/**`
  sauf `driver-safety.tsx` ; `apps/web/components/network-share/given-view.tsx`, `received-view.tsx`,
  `given-actions.tsx` ; `apps/web/components/chat/**` ; `apps/web/components/shell/dashboard-nav.ts` et son test
  (pastille de Messages) ; `packages/shared/src/platform-fees.ts` (`platformDueSummary` : format en cache seulement).
- **Changements** :
  1. **Encaissements (centrale)** : carte Rydar (propriétaire et administrateur) réduite à une bande : taux (« 5 € par
     course terminée »), montant principal (point 2), prochaine échéance, solde (« Solde : 330 € »), hausse annoncée et
     sa date d'effet, boutons « J'ai payé » et « Relevé » ; avis gardés (création suspendue, relance de Rydar, hausse) ; détail
     (4 chiffres, « vos frais sont dus même si le chauffeur ne vous a pas encore payé », historique des paiements)
     dans un `Disclosure` ouvert d'office en cas de blocage ; ancre `#frais-plateforme` gardée. Tuiles : 4 dans l'ordre
     d'action (À confirmer, En retard, À encaisser, À verser ; liens actuels) ; une ligne « Ce mois-ci : encaissé,
     commissions, volume » ; tuile « Frais plateforme du mois » supprimée (doublon) ; description « Ce que vos
     chauffeurs vous doivent, ce que vous leur devez, et vos frais Rydar. ».
  2. **Un seul montant des frais Rydar** : `payNowSummary(account, now)` (pur, testé ; à partir de `due_cents`,
     `declared_cents`, `balance_cents`, `next_due_cents`, `next_due_at` déjà lus) → « À payer maintenant : 85 € · en
     retard depuis 4 jours » (rouge), sinon « À régler avant le 5 nov. : 235 € » (ambre), sinon « Rien à régler »
     (vert) ; en petit : « Solde : 330 € » (jamais rouge s'il n'est pas échu), « Déjà déclaré 10 €, Rydar doit
     confirmer ». Même phrase sur la carte, le bandeau et la fenêtre « J'ai payé ». Le montant du lien de paiement reste
     calculé en SQL : si un paiement est déjà déclaré, l'aide dit « La page de paiement propose 95 € : indiquez 85 €
     (10 € déjà déclarés). ».
  3. **« J'ai payé Rydar »** en deux temps : « Payer Rydar » (montant en grand, « Payer en ligne », RIB dans « Payer par
     virement ») puis « Déclarer votre paiement » (montant prérempli, moyen, date ; référence et note dans « Ajouter une
     référence ou une note », ouvert d'office si erreur) ; `DialogFooter sticky` sur téléphone ; « reversement » →
     « paiement » ; `declarePlatformPayment` et sa validation inchangés.
  4. **Règlements** : bascule « Par course | Par chauffeur » (l'ancienne carte « Soldes par chauffeur » devient la vue
     « Par chauffeur » ; un chauffeur ouvre `?driver=…` ; montants à zéro masqués, phrase « doit 30 €, en retard ») ;
     onglets « À traiter · Réglés · Annulés · Tous » + puces À confirmer, En retard, Contestés, À verser visibles
     seulement si leur compteur dépasse zéro ou si elles sont actives (mêmes clés : « Réglés » = `paid`) ; « à encaisser
     / à verser » seulement sur un règlement ouvert, sinon « commission » / « part chauffeur » ; répartition en phrase
     (`splitSummary`) sur grand écran aussi, légende retirée ; « Rouvrir » dans le menu ⋮ ; « Pas reçu » en bouton
     direct seulement si le chauffeur a déclaré avoir payé ou si l'échéance est passée, sinon dans ⋮ (même dialogue,
     motif obligatoire) ; un seul libellé d'état chauffeur (« Actif » ou « Bloqué · commission en retard »), jamais
     tronqué. Contrat d'URL (`?filter=`, `?driver=`, `&n=`, `#reglements`) et sélection groupée (`carrySelection`)
     inchangés.
  5. **Moyens de paiement** (sélecteurs web) : un ordre et des libellés uniques — Virement, Lien de paiement, Espèces,
     [Carte], Autre moyen — par surcharge web (`SETTLEMENT_METHOD_META` non modifié).
  6. **Relevés** (`/dashboard/settlements/rydar`, `/dashboard/rydar/releve`) : titre « Relevé des frais Rydar » pour les
     deux modèles ; « Détail des frais », « Reste dû au 1er octobre » / « Reste dû fin octobre » ; une ligne par course
     (« #1022 · 1 oct. 10:08 · Gare Saint-Lazare → Accor Arena · 60 € payé en ligne · +5 € » + badge du règlement, numéro
     une seule fois) ; en-tête par échéance (« À régler le 5 nov. · 47 courses · 235 € ») ; 20 lignes puis « Afficher
     les 47 » ; mois sans activité masqués sauf le mois en cours ; bouton « J'ai payé » sur la page ; mentions de
     correction, d'avoir, d'attente et de refus gardées ; montants et export CSV inchangés.
  7. **Frais Rydar d'une flotte et d'une Flotte Privée** (`/dashboard/rydar`) : « Comment sont calculés vos frais
     Rydar » replié (texte inchangé) ; Flotte Privée : sans « Vos chauffeurs ne voient jamais ces frais » ; « Réglages →
     Abonnement » devient un lien vers `/dashboard/settings?tab=billing`.
  8. **Inscriptions / Réseau** (`/dashboard/network`) : candidatures en premier, pleine largeur, quand il y en a, sinon
     la création du lien ; puis le lien ; puis « Sécurité » (bannis, signalements, décisions) ; tuiles `StatCard`
     remplacées par une phrase ; « Signalements envoyés à Rydar » et « Dernières décisions » masqués s'ils sont vides ;
     aucun banni → une ligne « Pour bannir un fraudeur : sa fiche → Bannir définitivement » ; aide de « Lien actif »
     selon l'état ; « ci-contre » → « dans Candidatures » (rappel légal de `autoApproveHelp` gardé) ; « Régénérer le
     lien » sous « Options du lien » ; bannis par `orgWords` (« Banni de votre flotte ») ; puce d'identité : bouton texte
     « Débloquer » (confirmation existante) et téléphone non répété en clair ; note de lecture seule du dispatcher en
     haut ; lien des seuils vers `/dashboard/settings?tab=centrale`. `NetworkLive` inchangé ; Flotte Privée en 404.
  9. **Réseau partagé** : courses confiées : 3 tuiles (À encaisser, À verser, À vérifier), « En retard » et « En cours »
     en puces ; puces visibles : Toutes, celles au-dessus de zéro, Réglées ; partenaire, mois et export dans une ligne
     « Filtrer » repliée sur téléphone ; courses reçues : « En course partenaire » et « Créneaux pris » masqués s'ils
     sont vides ; « Paiement reçu » ; « part à vous reverser » ; « Réglées » et « Tous » au même endroit que dans
     Encaissements. Contrat d'URL (`paths.ts`) et page suspendue inchangés.
  10. **Messages** : « signalement » réservé aux alertes route ; file de modération « N message(s) à modérer » (pastille
     du menu comprise : `badgeLabel` de `dashboard-nav.ts` et son test) ; « · centrale » → « · équipe » ; « Les
     annonces de la centrale » → « Vos annonces » ; `chat-utils.ts` avec `dateTimeFormat`.
  11. `new Intl` au rendu → `dateTimeFormat` dans `org-platform-format.ts`, `org-statement.tsx`, `org-payer-context.ts`,
     `chat-utils.ts` et `platformDueSummary` (sorties identiques ; `formatToParts` disponible sur le format mis en
     cache).
- **Critères d'acceptation** :
  1. Encaissements montre sans rien déplier : taux, hausse annoncée et date d'effet, solde, échéance, lien
     « Relevé » ; `cgv-pages.test.ts` passe ; `git diff -- packages/shared/src/centrale.ts` vide.
  2. `pay-now.test.ts` : avance (solde négatif), rien d'échu, déclaré supérieur à l'échu, blocage, flotte ; la carte, le
     bandeau et la fenêtre affichent la même phrase (captures).
  3. 390 : titre « Règlements » avant 1 400 px (avant ≈ 3 350) ; relevé d'octobre ≤ 3 500 px (avant 8 066).
  4. `settlement-list.test.ts`, `settlement-flags.test.ts`, `org-platform-format.test.ts`, `org-platform-paths.test.ts`,
     `org-payer-context.test.ts`, `join-copy.test.ts` (adapté, sens gardé), `web2-texts.test.ts`, tests de
     `network-share/` et `dashboard-nav.test.ts` (adapté) passent.
  5. Aucun « Annuler la dette », « Dettes chauffeurs annulées », « Écritures », « Solde d'ouverture », « ci-contre »,
     « votre centrale » chez une flotte dans le texte visible.
- **Contrôles** : minimaux ; captures centrale (Encaissements, onglets, fenêtres, relevé), flotte (Frais Rydar,
  Inscriptions), dispatcher (Encaissements, Inscriptions), Messages ; réseau partagé ouvert pour les captures par
  l'interrupteur de `/admin/reseau` (base locale seulement), puis refermé.

---

### R10 — Clients : réglages, API & site web, mini-site

- **Objectif** : réglages lisibles du plus simple au plus technique, sans faux tarifs ni impasses d'abonnement ; plus
  aucune coupure d'accès en un clic ; documentation technique repliée.
- **Chemins autorisés** : `apps/web/app/dashboard/settings/page.tsx` ; `apps/web/app/dashboard/settings/actions.ts`
  (`fieldErrors` dans les retours en échec seulement ; gardes et validation inchangées, garde de `inviteMember` à sa
  place) ; `apps/web/components/settings/**` ; `apps/web/components/settlements/centrale-settings-form.tsx`,
  `reminder-settings.tsx`, `settlement-methods-fields.tsx` ; `apps/web/components/whatsapp/whatsapp-card.tsx` ;
  `apps/web/app/dashboard/integrations/page.tsx` ; `apps/web/components/dashboard-integrations.tsx`,
  `apps/web/components/dashboard-webhooks.tsx`, `apps/web/components/dashboard-integrations.test.ts` (phrases
  gardées) ; `apps/web/app/dashboard/booking-site/page.tsx`, `apps/web/components/booking/booking-site-form.tsx` ;
  `apps/web/lib/use-unsaved-guard.ts` (nouveau) ; `packages/shared/src/schemas.ts` (`API_SCOPE_LABELS` seulement) ;
  `docs/FLOTTE-PRIVEE.md` (§ 7.3, noms des onglets).
- **Changements** :
  1. **Onglets** : ordre Organisation · Tarifs · Dispatch · [Commission & encaissement] · Équipe · Abonnement ;
     **Organisation par défaut pour tous** (`?tab=` hors liste → Organisation) ; sous `sm`, `FilterTabs` « rubriques »
     en retour à la ligne (onglet actif toujours visible) ; description d'une phrase ; pastille « À compléter » sur
     Organisation (`bookingOperatorGaps` non vide) et sur Tarifs (aucune règle) ; `useUnsavedGuard(dirty)` (alerte
     `beforeunload` + confirmation au clic sur un autre onglet) pour Dispatch, Commission & encaissement et la grille
     tarifaire ; onglet « Abonnement » masqué au non-administrateur. Flotte Privée : onglets « Coordonnées », « Tarifs »,
     « Délais et rappels », « Abonnement » (clés inchangées : `org`, `pricing`, `bookings`, `billing`).
  2. **Organisation** : « Identité de votre entreprise » ; « optionnel » retiré de la raison sociale, du SIRET, de
     l'adresse et du n° VTC, avec sous chacun d'eux vide « Nécessaire pour vos factures et la mise en ligne » et un
     résumé en tête (« 2 informations manquantes ») ; `type`, `inputMode` et `autoComplete` ; `fieldErrors` affichés
     sous les champs (aussi pour Tarifs, Dispatch et Équipe).
  3. **Tarifs** : catégorie sans règle = champs vides avec exemples, mention « Aucun tarif : aucun prix proposé » (Flotte
     Privée : « votre site n'affiche pas de prix pour cette catégorie ») et bouton « Utiliser des valeurs de départ » ;
     un seul formulaire, une `fieldset` par catégorie (légende = catégorie), libellés des champs inchangés (`sr-only`
     sur grand écran sous une ligne d'en-têtes), suivi des lignes modifiées et barre collante « Modifications non
     enregistrées · Enregistrer » ; à l'envoi, `savePricingRule` (inchangée) pour chaque ligne modifiée, l'une après
     l'autre, erreur sous la ligne concernée, `router.refresh()` une fois à la fin, `fixed_fares` transmis tel quel ;
     unités (€, €/km, €/min, %) et « 1,8 » ; « Nuit % » avec l'aide « majoration de 21 h à 6 h » (heures lues) ;
     exemple calculé par `estimatePrice` (« Ex. 20 km, 30 min, de jour : 54 € ») ; Flotte Privée : catégorie du véhicule
     en tête, les autres sous « Autres catégories (réservations à vérifier) ».
  4. **Dispatch** : visibles : dispatch automatique, zones de recherche (vagues + relance), temps laissé pour accepter,
     rappels, paiement par défaut, surclassement ; `Disclosure` « Réglages avancés » : seuil de course immédiate,
     recherche à T-, maximum par vague, fraîcheur GPS (et résumés d'une ligne de « Suivi des vols » et « Alertes de
     suivi ») ; libellés en français courant (reportés dans `SETTINGS_LABELS`) : « Temps laissé aux chauffeurs pour
     accepter », « Une course est immédiate si le départ est dans moins de », « Course réservée à l'avance sans
     chauffeur : chercher un chauffeur proche … avant le départ », « Chauffeurs prévenus au maximum à chaque vague »,
     « Ignorer un chauffeur dont la position date de plus de », « Zones de recherche successives », « Une alerte sonne
     au tableau de bord ; vous décidez » ; éditeur des zones : « Retirer la dernière vague » / « Ajouter une vague » ;
     frise des vagues sous les zones au téléphone ; `aria-pressed` sur les puces de rappel ; `updateDispatchSettings`
     inchangée (la commission d'une flotte reste ici).
  5. **Commission & encaissement** : ordre Commission → Encaissement (délai, moyens) → Relances → Blocages et
     confiance ; « Enregistré automatiquement » sous le canal de relance ; WhatsApp Business : bouton « Relier un numéro
     WhatsApp Business (configuration technique) » qui déplie formulaire et aide, puis état + message test et
     « Modifier la connexion » ; `window.confirm` → `ConfirmDialog` ; « Message du bouton « Réclamer » — envoyé depuis
     votre WhatsApp, sans configuration » replié dans Encaissement ; « Dette maximale d'un chauffeur », « Prix maximum
     pour un nouveau chauffeur », « Chauffeur confirmé après » ; variables du lien de paiement repliées (« {montant} est
     remplacé par la somme due » visible) ; libellés « Pourcentage du prix » et « Lien de paiement » inchangés (recette).
     `WhatsAppCard` sert aussi `/admin/reglages` : même repli des deux côtés.
  6. **Équipe** : fenêtre « Ajouter un membre » : « La personne reçoit un e-mail pour choisir son mot de passe. » ; mot
     de passe provisoire sous « Option : définir un mot de passe provisoire » ; rôle en `fieldset` + `radiogroup` ;
     administrateur « Tout, sauf l'abonnement (réservé au propriétaire) » ; pour un administrateur non propriétaire :
     « Seul le propriétaire peut changer un rôle ou retirer un accès » ; « Passer administrateur » / « Passer
     dispatcher » et « Désactiver » par `ConfirmDialog` (« Retirer l'accès de … ? Elle ne pourra plus ouvrir cet espace ;
     vous pourrez le rétablir. ») ; actions d'un membre dans un menu « ⋮ » sur téléphone ; `inviteMember` et
     `updateMember` inchangés hormis `fieldErrors`.
  7. **Abonnement** (`billing-panel.tsx`) : « Votre abonnement » (nom de l'offre ou « Offre personnalisée », prix, état
     en français, date utile) ; factures en français, deux niveaux au téléphone ; « Gérer mon abonnement » (« paiement,
     factures, résiliation ») seulement avec `stripe_subscription_id` ; abonnement Stripe en cours : comparaison des
     offres repliée et, à la place de « Choisir cette offre », « Pour changer d'offre, utilisez « Gérer mon
     abonnement » » ; non-propriétaire : « Seul le propriétaire du compte peut souscrire, changer d'offre ou résilier. » ;
     jauges illimitées en texte (« Illimité ») ; Flotte Privée : ni jauges « Chauffeurs » et « Administrateurs », ni
     « Le plus choisi », bascule Mensuel / Annuel seulement si une offre est payable en ligne ; bandeau « Paiement reçu :
     votre abonnement s'active dans quelques instants. » sur `?checkout=success` ; liens `/cgv`, `/dpa`,
     `/abonnement-resiliation` gardés près des boutons ; ombre lime en dur → jeton.
  8. **API & site web** : carte d'état d'abord (`siteLink()` de `site-status.ts` : « Votre site est relié (monsite.fr) ·
     dernière utilisation … » ou « Aucun site relié pour l'instant ») ; « Clés de connexion » (« Une clé relie votre site
     à votre compte. Donnez-la seulement à la personne qui gère votre site. ») ; « Notifications envoyées à votre site
     (webhooks) » ; `Disclosure` « Documentation pour votre développeur » (points d'entrée, exemples, journal des
     requêtes) ; onglets des exemples en retour à la ligne ; journal sur deux lignes sous `sm` ; « Nouvelle clé » : nom,
     permissions et origines autorisées visibles, « Limite de débit » sous « Options avancées » ; « Révoquer » et
     « Remplacer » (rotation) par `ConfirmDialog` (« Votre site ne pourra plus envoyer de réservations. » ; « L'ancienne
     reste valable 24 h : mettez votre site à jour avec la nouvelle. ») avec libellés visibles sur grand écran ; clé
     révoquée en texte normal + badge « Révoquée » ; `API_SCOPE_LABELS` : « Annuler des courses », « Calculer des
     devis », « Suivre les courses », « Webhooks » gardé ; « Non compris dans votre offre » + lien vers l'abonnement ;
     `aria-pressed` sur permissions et événements ; espaces insécables de l'exemple « Site web ».
  9. **Mini-site** (coupé en production) : grille `grid-cols-[minmax(0,1fr)]` + `min-w-0` (plus de débordement) ; liste
     « Pour mettre en ligne » sous l'interrupteur (téléphone, e-mail, conditions, raison sociale, SIRET, adresse, n° VTC,
     calculée par `bookingSitePublishable` + `bookingOperatorGaps`, lien « Compléter » vers `?tab=org`) et
     `fieldErrors.enabled` affiché ; « Une page de réservation prête à l'emploi, si vous n'avez pas de site » ; « Non
     compris dans votre offre ». Le reste est reporté (§ 6).
  10. **Vocabulaire** : deuxième personne, valable pour les deux modèles (« Part de la centrale » → « Votre part » ;
     « la centrale décide » → « vous décidez » ; « la centrale et le chauffeur sont prévenus » → « vous et le chauffeur
     êtes prévenus »), sinon `orgWords` ; exemple « monsite.fr » au lieu de « ma-centrale.fr » ; « tableau de bord » ;
     bulle WhatsApp et dégradés du radar en jetons ; `new Intl` de `whatsapp-card.tsx` → `dateTimeFormat`.
- **Critères d'acceptation** :
  1. 390 et 1440 : `scrollWidth` égal à la largeur sur Réglages (chaque onglet), API & site web (et ses deux fenêtres),
     Mini-site, Mon site ; Dispatch à 390 ≤ 2 600 px (avant 3 780).
  2. Une catégorie sans règle n'affiche plus de valeurs ; deux lignes modifiées puis un seul « Enregistrer » → deux
     règles enregistrées ; une erreur sur la seconde laisse la première enregistrée et la seconde marquée.
  3. Révoquer, remplacer une clé, changer un rôle, retirer un accès demandent une confirmation ; `s3-keys`,
     `s10-smoke-standard`, `s2-activate`, `s8-switch` (réglages centrale) adaptés passent.
  4. `dashboard-integrations.test.ts` (2 phrases mot pour mot), `webhooks.test.ts` (« Webhooks »),
     `domaine-stripe.test.ts` (« Gérer » dans le message 409, bouton « Gérer mon abonnement »), `legal-pages.test.ts`
     (liens de l'abonnement), `billing-offers.test.ts`, `private-booking.test.ts`, `private-fleet-guards.test.ts`
     passent ; test ajouté pour `useUnsavedGuard` (fonction pure de décision) et pour la sélection des lignes modifiées.
  5. `grep -rn 'href="/dashboard/settings"' apps/web/app apps/web/components` ne renvoie rien : seul le menu
     (`href: "/dashboard/settings"` dans `dashboard-nav.ts`) mène à l'onglet par défaut ; les liens de `driver-earnings.tsx`
     et de `network/page.tsx` nomment leur onglet depuis R8 et R9.
- **Contrôles** : minimaux ; captures de chaque onglet pour flotte, centrale, dispatcher, Flotte Privée ; recette
  `s2-activate` (onglets « Coordonnées », « Tarifs », « Délais et rappels », « Abonnement » ; `?tab=team` →
  « Coordonnées »), `s3-keys` (grille : `getByRole("group", { name: "Business" })` puis les mêmes libellés, un seul
  « Enregistrer » ; onglet `bookings`), `s10-smoke-standard`, `s8-switch`.

---

### R11 — Contrôle final, recette et documentation

- **Objectif** : vérifier l'ensemble sur la pile locale complète, retirer les restes, documenter. Tout défaut se corrige
  dans le lot propriétaire du fichier (rouvert), jamais ici.
- **Chemins autorisés** : `apps/web/components/layout/page-header.tsx` (retrait de `eyebrow`) et les fichiers qui
  passent encore `eyebrow=` (retrait de l'attribut, rien d'autre) ; `docs/REFONTE-PANELS.md` (statuts, écarts) ;
  `docs/EN-COURS.md` (compte rendu) ; `docs/FLOTTE-PRIVEE.md` (statut).
- **Changements** : retrait de la propriété `eyebrow` et de ses usages ; compte rendu de recette dans `docs/EN-COURS.md`
  (pages, contrôles, mesures avant / après de l'annexe A, écarts) ; statuts des lots.
- **Critères d'acceptation** :
  1. Texte visible des espaces connectés (relevé par `mesure.mjs` sur toutes les pages des 5 profils, détails fermés,
     § 9.3) sans : `rattacheur`, `tenant`, `RLS`, `trigger`, `outbox`, `worker`, `MRR`, `Option 1`, `Option 2`,
     `Instantané`, `Timeline`, `Debug`, `DBG`, `WRN`, `Dashboard`, `failed`, `queued`, `trialing`. En complément,
     `grep -rniE "<motif>" apps/web/app/admin apps/web/app/dashboard apps/web/components | grep -vE ":\s*(//|\*|/\*)"`
     et lecture de chaque reste (identifiants de code admis).
  2. `grep -rn "new Intl\." apps/web/app/admin apps/web/app/dashboard apps/web/components` : chaque reste est listé et
     justifié dans le compte rendu (attendus : routes d'export CSV et de factures, action serveur de
     `app/dashboard/drivers/actions.ts`, `components/booking/zoned-time.ts` — calculs hors rendu ou pages publiques).
  3. Mesures du § 9.3 sur toutes les pages des 5 profils : aucun débordement à 390 ni à 1440 ; cibles de l'annexe A
     atteintes ou écart expliqué.
  4. Recette complète `l7/e2e/run-all.sh` (scripts adaptés par les lots) : tous les contrôles verts ; captures « après »
     des 5 profils.
  5. `pnpm typecheck`, `pnpm test`, `TEST_DATABASE_NAME=rydar_test_refonte pnpm test:db`, `pnpm build`,
     `pnpm --filter @rydar/driver export:check` passent ; aucun fichier de `supabase/`, `apps/driver/` ni
     `apps/worker/` dans les commits de la refonte (`git log --name-only` des commits R1 à R10).
- **Contrôles** : ceux des critères.

---

## 9. Recette, captures et mesures

### 9.1 Pile locale

- PostgreSQL : `pg_ctlcluster 16 main start` ; Supabase local : `bash scripts/local-stack/start.sh` (passerelle :54321,
  déjà installé) ; géo de dev : `scripts/dev-geo` ; worker si besoin : `pnpm dev:worker`.
- Web en build de production pour les captures et les mesures : `pnpm --filter @rydar/web build` puis
  `pnpm --filter @rydar/web exec next start --port 3210` (les scripts de capture visent `localhost:3000` résolu vers
  3210).
- Base de recette : base `rydar` avec le seed (3 organisations, 29 chauffeurs) et le client Flotte Privée de
  démonstration « Lambert » créé par `scratchpad/refonte/photo/fp-setup.mjs`. Attention : `l7/e2e/reset.sh` recrée la
  base ; relancer alors `fp-setup.mjs` et mettre à jour l'identifiant de la fiche Lambert dans
  `refonte/photo/pages-superadmin.json`.

### 9.2 Captures

- Outil : `scratchpad/refonte/photo/shoot.mjs <rôle>` (rôles `superadmin`, `flotte`, `centrale`, `dispatcher`,
  `flotteprivee` ; écritures bloquées pendant l'exploration ; 1440×900 puis 390×844 à l'échelle 2). Pour « après », le
  copier en `shoot-apres.mjs` avec `OUT` = `scratchpad/refonte/apres/<lot>/`. Identifiants des profils : ceux du script
  (comptes de démonstration du seed local) ; jamais dans le dépôt.
- Les captures à 390 sont à l'échelle 2 : hauteur CSS = hauteur de l'image ÷ 2.

### 9.3 Mesures (débordement, hauteur, menu)

Script hors dépôt `scratchpad/refonte/controle/mesure.mjs`, écrit en R1 et réutilisé : pour chaque rôle et chaque page
de `refonte/photo/pages-<rôle>.json`, à 390×844 et 1440×900, relever `document.documentElement.scrollWidth`,
`scrollHeight` (CSS) et, pour la barre, le rectangle de la dernière entrée du menu (`nav[aria-label="Menu principal"]
a:last-of-type`) ; échec si `scrollWidth > innerWidth` ou si la dernière entrée sort de la fenêtre sans défilement du
menu. Le script enregistre aussi `document.body.innerText` de chaque page (replis fermés) pour les contrôles de
vocabulaire. Sortie JSON comparée à l'annexe A ; écritures bloquées comme dans `shoot.mjs`.

### 9.4 Scripts de recette (hors dépôt)

`scratchpad/l7/e2e/` (`lib.mjs`, `run-all.sh`, étapes `s1` à `s11`) : chaque lot adapte les étapes dont il change un
sélecteur (annexe C) et les relance ; R11 relance tout. Chromium : `executablePath: "/opt/pw-browsers/chromium"`.

---

## 10. Tutoriel de première connexion (phase suivante, hors refonte)

Rien de ce qui suit n'est fait dans les lots R1 à R11. La refonte en prépare le terrain : lexique stable (§ 4), menus
définitifs, blocs « À traiter » (super admin, En direct, Flotte Privée), ancres de section (`#a-traiter`,
`#frais-plateforme`, `#reglements`, `#a-valider`) et Premiers pas de la Flotte Privée.

### 10.1 But et principes

- Mener chaque profil à **son premier résultat utile** (premier client créé, première course attribuée, premier
  paiement confirmé, première réservation confirmée), pas faire visiter les menus.
- Court (5 étapes au plus par parcours), interrompable, reprenable (« Reprendre la visite » dans le menu du compte),
  jamais bloquant : il ne masque ni un contrôle, ni un bandeau légal, ni l'écran d'acceptation des CGV / CGU (qui
  passe toujours avant).
- Chaque étape renvoie à l'écran réel et à une action réelle ; **aucune donnée fictive créée en production** (pas de
  course ou de client « de démonstration » automatique).
- Accessible : fenêtre au focus géré (Échap, clavier, lecteur d'écran), aucune animation en boucle, contraste ≥ 4,5:1,
  utilisable à 390 px ; vocabulaire du lexique ; typographie française.
- Conformité : aucun outil tiers de visite guidée ni de mesure d'audience (CNIL) ; mémoire de la progression soit en
  base (préférence par utilisateur : migration, RLS, GRANT par colonne, à faire dans cette phase), soit en stockage
  local (ligne dans `/cookies` d'abord). Recommandation : en base, pour suivre l'utilisateur d'un appareil à l'autre.
- Mesure du succès sans traceur : uniquement à partir des données déjà en base (Premiers pas complets, première course
  créée, premier paiement confirmé).

### 10.2 Parcours à couvrir

1. **Super admin (propriétaire)** : compléter les informations légales de l'éditeur (sans elles, aucun client ne peut
   accepter les CGV) ; Réglages de la plateforme (coordonnées de paiement de Rydar, WhatsApp facultatif, interrupteur
   des mini-sites) ; Offres & limites ; « Nouveau client » (3 types) et invitation du gérant ; Flotte Privée : clé du
   site après acceptation des CGV par le client ; routine quotidienne : « À traiter » de la vue d'ensemble, confirmer un
   paiement dans Frais Rydar, examiner un signalement ; où regarder quand un client se plaint (Supervision).
2. **Gérant de flotte** : CGV et DPA (déjà imposés) ; Réglages › Organisation (raison sociale, SIRET, n° VTC) ;
   Tarifs ; ajouter un chauffeur ou partager le lien d'inscription ; installer l'application chauffeur (mêmes
   identifiants) ; créer une course et la suivre sur En direct (« À traiter ») ; inviter un dispatcher (Équipe) ;
   zones de recherche du dispatch (avancé) ; Frais Rydar s'il y en a ; API & site web (facultatif).
3. **Gérant de centrale** : comme la flotte, plus Commission & encaissement (commission, moyens de paiement, délai,
   blocage), lien d'inscription et validation des candidatures, Encaissements (« Reçu », « Pas reçu », relances),
   frais Rydar dans Encaissements (« J'ai payé »).
4. **Dispatcher** : En direct (carte, panneau des courses, « À traiter »), Nouvelle course, Attribuer, Messages,
   Journal du dispatch ; ce qui est en lecture seule pour lui et à qui s'adresser.
5. **Flotte Privée** : s'appuyer sur Premiers pas (entreprise complète, tarifs actifs, documents valides, application
   utilisée, site relié) sans le dupliquer ; confirmer une réservation (application : « Confirmer » ; web : « Je la
   prends »), l'agenda, Mon site, Réglages › Délais et rappels ; Frais Rydar s'il y en a.
6. **Chauffeur (application)** : hors de ce tutoriel web ; un parcours dans l'app demanderait une mise à jour EAS et ses
   propres règles (information préalable GPS, `requestLocationPermissions()`).

### 10.3 Questions au propriétaire avant de commencer

- Déclenchement : à la première connexion seulement, ou aussi à la demande (« Visite guidée ») ?
- Mémoire de la progression : en base (recommandé) ou dans le navigateur ?
- Faut-il un parcours dans l'application chauffeur (nouvelle version des stores ou mise à jour EAS) ?
- Une vidéo ? Seulement hébergée par Rydar (aucune vidéo tierce sans gestionnaire de consentement).

---

## Annexe A — Mesures avant et cibles

Hauteurs en pixels CSS (`scrollHeight`), base de recette du § 9.1. « Avant » : captures de `refonte/avant/` (390 :
hauteur d'image ÷ 2). Mesures « après » (R11, même base) : `docs/EN-COURS.md`, toutes les cibles atteintes ; après la
revue, `/admin` à 390 mesure 2 206 px (écart gardé, § 8.2).

| Page | Profil | Largeur | Avant | Cible | Lot |
|---|---|---|---|---|---|
| `/admin` | super admin | 390 | 3 645 | ≤ 2 200 | R3 |
| `/admin` | super admin | 1440 | 1 940 | ≤ 1 700 | R3 |
| `/admin/organizations/[Élite]` | super admin | 390 | 4 474 | ≤ 3 000 | R4 |
| `/admin/organizations/[Express]` | super admin | 390 | 4 952 | ≤ 3 300 | R4 |
| `/admin/organizations/[Lambert]` | super admin | 390 | 4 544 | ≤ 3 600 | R4 |
| `/admin/frais` | super admin | 390 | 4 594 | ≤ 3 000 | R5 |
| `/admin/frais/[Express]` | super admin | 390 | 6 785 | ≤ 4 500 | R5 |
| `/admin/audit` | super admin | 1440 | 7 394 | ≤ 3 000 | R6 |
| `/admin/reseau` (fermé) | super admin | 390 | 2 319 | ≤ 1 400 | R6 |
| `/dashboard/drivers/[id]` | flotte | 390 | 4 782 | ≤ 3 500 | R8 |
| `/dashboard/settlements` : haut de « Règlements » | centrale | 390 | ≈ 3 350 | ≤ 1 400 | R9 |
| `/dashboard/settlements/rydar` (octobre) | centrale | 390 | 8 066 | ≤ 3 500 | R9 |
| `/dashboard/settings?tab=dispatch` | flotte | 390 | 3 780 | ≤ 2 600 | R10 |
| `/dashboard/integrations` : largeur | centrale | 390 | 434 | 390 | R10 |
| `/dashboard/booking-site` : largeur | centrale | 390 | ≈ 1 180 | 390 | R10 |
| Barre latérale : dernière entrée visible | tous | 1440×900 | non (super admin, propriétaires, dispatcher) | oui | R1, R2 |

## Annexe B — Tests du dépôt touchés

| Test | Ce qu'il protège | Lot | Changement attendu |
|---|---|---|---|
| `components/shell/dashboard-nav.test.ts` | menus standard et Flotte Privée, sous-titre de la barre | R1, R9 | instantanés standard mis à jour (sections, dispatcher, pastilles) ; cas Flotte Privée inchangés |
| `components/shell/dashboard-links.test.ts` | `prefetch` explicite | R1 | périmètre étendu à l'admin + contrôle du nouvel onglet |
| `components/legal/cookie-notice.test.ts` | bandeau dans le flux, avant le compte | R1 | aucun |
| `components/legal/legal-pages.test.ts` | liens légaux, liens de l'abonnement | R1, R10 | aucun |
| `lib/not-found-page.test.ts` | 404 neutre | R1 | aucun (+ nouveau test des 404 de segment) |
| `components/network-share/web2-texts.test.ts` | mots interdits, préchargement, couleurs | R4, R6, R7, R9 | aucun |
| `components/legal/network-terms.test.ts` | positionnement du réseau | R6 | aucun |
| `components/shell/private-fleet-guards.test.ts` | masqué ET refusé | R8, R10 | aucun |
| `components/shell/dashboard-layout.test.ts` | lectures du layout | R1, R8 | aucun |
| `components/agenda/agenda-model.test.ts`, `agenda-views.test.ts` | agenda | R8 | libellés « course » / « réservation » selon le profil, aucun cas retiré |
| `components/network/join-copy.test.ts` | textes du lien d'inscription | R9 | « ci-contre » → « dans Candidatures », rappel légal gardé |
| `components/platform-fees/*.test.ts` | formats, chemins, contexte de paiement | R5, R9 | mêmes sorties |
| `components/settlements/settlement-list.test.ts`, `settlement-flags.test.ts` | sélection, drapeaux | R9 | aucun |
| `components/dashboard-integrations.test.ts`, `lib/webhooks.test.ts` | phrases de la clé navigateur, « Webhooks » | R10 | aucun |
| `lib/domaine-stripe.test.ts` | message 409 « Gérer » | R10 | aucun |
| `components/settings/billing-offers.test.ts`, `private-booking.test.ts` | offres, réservations Flotte Privée | R10 | aucun |
| `components/legal/cgv-pages.test.ts` | menus cités par l'article 5 | R9 | aucun |
| `lib/private-fleet-admin.test.ts` | création, clé du site, bascules | R3, R4 | aucun |
| `packages/shared/src/webhooks.test.ts` | libellé « Webhooks » des portées | R10 | aucun |

## Annexe C — Sélecteurs des scripts de recette touchés (hors dépôt, `scratchpad/l7/e2e/`)

| Script | Sélecteur actuel | Lot | Adaptation |
|---|---|---|---|
| `s1-create`, `refonte/photo/fp-setup.mjs` | bouton « Nouveau client Flotte Privée » ; champs « Raison sociale », « SIRET », « N° d'inscription au registre VTC » | R3 | cliquer « Nouveau client » d'abord ; ouvrir « Informations légales (facultatif) » |
| `s2-activate` | `aside`, « Menu principal », onglets « Mon entreprise », « Réservations » ; `?tab=team` → « Mon entreprise » | R1, R10 | onglets « Coordonnées », « Délais et rappels » |
| `s3-keys` | grille : `form` filtrée par « Business », libellés de tarif, « Enregistrer » dans ce formulaire ; fiche admin : « Nouvelle clé », « Clé navigateur » / « Clé serveur », « Adresses du site », « Générer la clé », « J'ai copié la clé » | R4, R10 | grille : `getByRole("group", { name: "Business" })` + « Enregistrer » unique ; noms de la fiche gardés |
| `s7b-pages` | fiche Flotte Privée : « Je la prends », « Refuser », « Annuler », « Modifier le prix » ; jamais « Attribuer », « Relancer », « Retirer » | R7, R8 | accepter « Fixer le prix » quand la réservation n'a pas de prix |
| `s8-switch` | « Passer en flotte standard » ; `radiogroup` « Modèle d'exploitation » ; « Enregistrer ».first() ; réglages centrale « Pourcentage du prix », « Lien de paiement », « Enregistrer ».last() ; « Ajouter un chauffeur » et ses champs | R4, R8, R10 | ouvrir « Offre de service et réseau partagé » et « Modifier le modèle ou les frais » ; viser l'« Enregistrer » de la carte ; libellés de réglages et du chauffeur gardés |
| `s9-return` | « Passer en Flotte Privée ».first() | R4 | ouvrir « Offre de service et réseau partagé » |
| `s10-smoke-standard` | « Propriétaire » dans `aside` ; « Nouvelle clé » ; « Origines autorisées (CORS) » ; 2 phrases de la clé navigateur | R1, R10 | aucun (origines restent visibles) |
| `s6`, `s6b`, `s7-agenda-web` | « Je la prends », « À traiter », agenda (« Jour », jours) | R8 | aucun attendu ; relancer |
