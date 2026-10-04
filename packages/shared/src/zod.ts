// zod configuré une fois pour tout le paquet. Chaque module l'importe d'ici (jamais de « zod » directement) : ce module
// est donc toujours évalué avant le premier schéma, quel que soit le découpage des bundles. Seul module du paquet
// déclaré avec effets de bord (package.json, « sideEffects ») : sans cela, un bundler qui n'y lit que la réexportation
// de `z` sauterait ses z.config (vu avec Turbopack : zod sans la configuration, CSP « eval » signalée sur /contact).
import { z } from "zod";
// La seule locale utilisée : `z.locales.fr()` embarquerait les ~70 locales de zod (≈ 390 Ko de JS) dans chaque page
import fr from "zod/v4/locales/fr.js";

// Messages de validation en français (API publique, formulaires).
z.config(fr());
// Cas courants en langage simple (sinon « Trop petit : chaîne de caractères doit avoir >=2 caractères ») ;
// un message écrit dans un schéma reste prioritaire, et le reste suit la locale française.
z.config({
  // Pas de compilation à la volée (new Function) : interdite par la politique de sécurité du site (CSP sans
  // unsafe-eval), que le navigateur signale à chaque tentative
  jitless: true,
  customError: (issue) => {
    if (issue.code === "invalid_type" && issue.input === undefined) return "Champ obligatoire";
    if (issue.code === "invalid_format" && issue.format === "email") return "Adresse e-mail invalide";
    if (issue.code === "too_small" || issue.code === "too_big") {
      const bound = Number(issue.code === "too_small" ? issue.minimum : issue.maximum);
      const small = issue.code === "too_small";
      if (issue.origin === "string") {
        if (small && bound <= 1) return "Champ obligatoire";
        return `${bound} caractères ${small ? "minimum" : "maximum"}`;
      }
      if (issue.origin === "number" || issue.origin === "int") {
        if (issue.inclusive === false) return small ? `Doit être supérieur à ${bound}` : `Doit être inférieur à ${bound}`;
        return `${small ? "Minimum" : "Maximum"} ${bound}`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return small ? `Au moins ${bound} élément${bound > 1 ? "s" : ""}` : `${bound} éléments au maximum`;
      }
    }
    return undefined;
  },
});

export { z };
