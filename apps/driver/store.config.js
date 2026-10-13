// Fiche App Store de l'app chauffeur (EAS Metadata), envoyée depuis apps/driver par
//   npx eas-cli@latest metadata:push --profile production
// (docs/STORES.md § 5). Textes : ceux de docs/STORES.md § 7 (les changer ensemble). Captures : store/ios/*.png,
// 1320 × 2868 (iPhone 6,9 po, type d'écran APP_IPHONE_67 de l'API d'App Store Connect).
// Contact de la vérification et compte de démonstration : variables d'environnement du terminal, jamais dans le
// dépôt ; sans elles, la section « review » n'est pas envoyée et se remplit dans App Store Connect.
//   STORE_REVIEW_FIRST_NAME, STORE_REVIEW_LAST_NAME, STORE_REVIEW_EMAIL, STORE_REVIEW_PHONE (+33…)
//   STORE_DEMO_EMAIL, STORE_DEMO_PASSWORD (compte « Démo App Review », docs/STORES.md § 2)
//   STORE_CONTACT_EMAIL (e-mail de /mentions-legales), STORE_REVIEW_VIDEO_URL (vidéo facultative)
//   STORE_COPYRIGHT_HOLDER (raison sociale de /admin/legal), STORE_DOMAIN (rydardrive.com par défaut)
const fs = require("fs");
const path = require("path");

const env = (name) => (process.env[name] || "").trim();
const domain = env("STORE_DOMAIN") || "rydardrive.com";
const site = `https://${domain}`;
// Même version que l'app (app.config.ts) : la fiche vise la version envoyée aux stores
const version = /version:\s*"(\d+\.\d+\.\d+)"/.exec(fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8"))[1];

const description = `Rydar Drive est l'application des chauffeurs VTC dont la centrale ou la flotte travaille avec Rydar Drive.

• Passez EN LIGNE : les courses proches vous sont proposées automatiquement, avec sonnerie, même téléphone verrouillé ou dans une autre application.
• Acceptez d'un geste : départ, destination, distance et prix (ou votre part) affichés avant d'accepter.
• Guidage intégré jusqu'au client puis à destination, ou ouverture dans Waze ou dans l'application de cartes du téléphone.
• Planning des courses réservées (liste, jour, semaine ou mois) et rappels avant chaque course.
• Messages avec votre centrale et signalements de la flotte (contrôles, accidents, bouchons).
• Gains du jour et de la semaine, commissions et règlements avec votre centrale.
• Documents (carte VTC, permis…) envoyés depuis l'app, avec rappel avant échéance.

L'application est réservée aux chauffeurs inscrits par une centrale : demandez votre lien d'inscription à votre centrale.

Position : quand vous êtes EN LIGNE ou en course, votre position est envoyée à votre centrale, y compris en arrière-plan, pour vous proposer les courses proches et suivre la course. Passer hors ligne ou fermer l'application arrête ce suivi ; seul un signalement que vous publiez envoie ensuite votre position.

Sécurité : au volant, ne manipulez pas votre téléphone ; acceptez les offres et écrivez vos messages à l'arrêt.

Rydar Drive est un logiciel de dispatch : les courses sont organisées par votre centrale, qui fixe les prix et les conditions.`;

const contact = env("STORE_CONTACT_EMAIL") || env("STORE_REVIEW_EMAIL");
const video = env("STORE_REVIEW_VIDEO_URL");
const notes = [
  `Rydar Drive is the driver app of a B2B dispatch software used by ride-hailing (VTC) companies in France. Drivers are registered by their company (or through the company's invitation link), so the app requires an account: use the demo account provided in the sign-in information (company "Démo App Review").`,
  `How to test (works from any location):`,
  `1. Sign in. If the Terms screen appears, tap "J'accepte" (see "Terms" below). Tap "Passer en ligne" (go online) and allow location "While Using the App".`,
  `2. Tap the calendar icon at the top (Planning): scheduled rides are offered to the demo account. Tap "Prendre cette course" (take this ride).`,
  `3. Under "Mes courses" (my rides), open the ride and slide "Aller au départ" (go to pickup): in-app turn-by-turn navigation starts. Keep sliding through each step until the ride is completed.`,
  `Instant ride offers (with a ringtone, even when the phone is locked) are only sent to drivers within 4 to 16 km of the pickup point, so the scheduled rides above are provided for the review.${video ? ` Video of an instant offer on a real device: ${video}` : ""}`,
  `Background location (UIBackgroundModes: location): while the driver is online, the app keeps sharing the driver's location, including when the app is in the background or the screen is locked, so that nearby rides can be offered and the company can follow the ride. The iOS location indicator is shown. Continuous location sharing stops when the driver goes offline or closes the app. "When In Use" permission only, requested after an in-app explanation.`,
  `Terms: every driver must accept our Terms of Use and Privacy Policy in the app, on a full-screen acceptance page shown at first sign-in and again for each new version; the sign-in screen links to them. The Terms (section 9) set the rules of the drivers' channel, with zero tolerance for objectionable content or abusive users.`,
  `Drivers' channel (chat bubble > "Chauffeurs"), the only place where drivers share content with each other: visible only to the company's drivers and staff. Before a driver's first post, the channel rules are displayed and must be accepted. With a long press on any message, a driver can report it to the company (it disappears from their feed at once) or hide all messages from its author. Reports reach the company's staff immediately in their dashboard; they delete the message for everyone or dismiss the report, and can suspend or exclude the author.${contact ? ` Illegal content can also be reported to us: ${contact}.` : ""}`,
  `Account deletion: Profil (Mon compte) > Supprimer mon compte, also offered when sign-in is refused (suspended or banned account). Privacy policy: ${site}/confidentialite · Terms: ${site}/cgu · Account deletion page: ${site}/suppression-compte`,
].join("\n");

const reviewer = ["STORE_REVIEW_FIRST_NAME", "STORE_REVIEW_LAST_NAME", "STORE_REVIEW_EMAIL", "STORE_REVIEW_PHONE"].map(env);
const demoEmail = env("STORE_DEMO_EMAIL");
const demoPassword = env("STORE_DEMO_PASSWORD");
const review = reviewer.every(Boolean)
  ? {
      firstName: reviewer[0],
      lastName: reviewer[1],
      email: reviewer[2],
      phone: reviewer[3],
      demoRequired: true,
      // Mot de passe absent : à saisir dans App Store Connect (Informations de connexion), jamais dans un chat
      ...(demoEmail ? { demoUsername: demoEmail } : {}),
      ...(demoEmail && demoPassword ? { demoPassword } : {}),
      notes,
    }
  : undefined;

const holder = env("STORE_COPYRIGHT_HOLDER");

module.exports = {
  configVersion: 0,
  apple: {
    version,
    ...(holder ? { copyright: `${new Date().getFullYear()} ${holder}` } : {}),
    categories: ["BUSINESS", "NAVIGATION"],
    release: { automaticRelease: true, phasedRelease: false },
    // Âge : aucun contenu sensible ; messagerie et fil « Chauffeurs » (contenu des utilisateurs, modéré)
    advisory: {
      alcoholTobaccoOrDrugUseOrReferences: "NONE",
      contests: "NONE",
      gamblingSimulated: "NONE",
      gunsOrOtherWeapons: "NONE",
      horrorOrFearThemes: "NONE",
      matureOrSuggestiveThemes: "NONE",
      medicalOrTreatmentInformation: "NONE",
      profanityOrCrudeHumor: "NONE",
      sexualContentGraphicAndNudity: "NONE",
      sexualContentOrNudity: "NONE",
      violenceCartoonOrFantasy: "NONE",
      violenceRealistic: "NONE",
      violenceRealisticProlongedGraphicOrSadistic: "NONE",
      gambling: false,
      lootBox: false,
      advertising: false,
      unrestrictedWebAccess: false,
      healthOrWellnessTopics: false,
      parentalControls: false,
      ageAssurance: false,
      messagingAndChat: true,
      userGeneratedContent: true,
      kidsAgeBand: null,
      ageRatingOverride: "NONE",
      koreaAgeRatingOverride: "NONE",
    },
    info: {
      "fr-FR": {
        title: "Rydar Drive Chauffeur",
        subtitle: "Courses VTC de votre centrale",
        promoText: "Les courses de votre centrale au bon moment : offres automatiques, guidage, planning et gains.",
        description,
        keywords: ["vtc", "chauffeur", "chauffeur privé", "courses", "dispatch", "centrale", "flotte", "réservation", "navigation", "planning"],
        marketingUrl: site,
        supportUrl: site,
        privacyPolicyUrl: `${site}/confidentialite`,
        // « Nouveautés » (docs/STORES.md § 7) : EAS ne les envoie pas pour la toute première version publiée
        releaseNotes: [
          "• Planning : vues Jour, Semaine et Mois, en plus de la liste.",
          "• Chauffeurs indépendants : réservations « à confirmer » et écrans simplifiés.",
          "• Connexion et « Mot de passe oublié » plus sûrs.",
          "• Corrections et améliorations de stabilité.",
        ].join("\n"),
        screenshots: {
          APP_IPHONE_67: ["1-accueil", "2-offre", "3-course", "4-planning", "5-gains", "6-messages"].map((n) => `./store/ios/${n}.png`),
        },
      },
    },
    ...(review ? { review } : {}),
  },
};
