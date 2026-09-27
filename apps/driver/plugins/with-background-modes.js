// Plugin de configuration local : modes d'arrière-plan iOS (UIBackgroundModes) réellement utilisés.
//
// expo-task-manager (plugin appliqué automatiquement par @expo/prebuild-config) ajoute toujours « fetch »
// (récupération en arrière-plan). Rydar Drive ne s'en sert pas (ni expo-background-fetch, ni
// expo-background-task), et Apple refuse les modes déclarés sans usage (App Store, règle 2.5.4).
// Seul « location » reste : la position EN LIGNE, app en arrière-plan ou téléphone verrouillé.
// « remote-notification » n'est pas déclaré : aucune notification silencieuse (content-available) n'est envoyée.
//
// Référencé en DERNIER dans `plugins` (app.config.ts) : les plugins du projet s'exécutent après les plugins
// automatiques et ont donc le dernier mot. Vérification : npx expo config --type introspect --json
const { withInfoPlist } = require("expo/config-plugins");

/** Modes retirés : aucune fonctionnalité de l'application ne les utilise. */
const UNUSED_MODES = ["fetch"];

module.exports = function withBackgroundModes(config) {
  return withInfoPlist(config, (c) => {
    const modes = Array.isArray(c.modResults.UIBackgroundModes) ? c.modResults.UIBackgroundModes : [];
    const kept = modes.filter((mode) => !UNUSED_MODES.includes(mode));
    if (kept.length) c.modResults.UIBackgroundModes = kept;
    else delete c.modResults.UIBackgroundModes;
    return c;
  });
};
