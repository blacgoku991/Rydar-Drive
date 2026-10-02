// Frais Rydar (côté organisation) : où ils se trouvent selon le modèle d'exploitation. Module neutre (pages serveur,
// composants client, route d'export).
//   • centrale : carte en tête de « Encaissements » (avec les commissions des chauffeurs), relevé /dashboard/settlements/rydar ;
//   • flotte : entrée « Frais Rydar » du menu (Organisation), page /dashboard/rydar, relevé /dashboard/rydar/releve
//     (pas d'« Encaissements » en flotte : aucune commission ni règlement chauffeur).
import type { DispatchModel } from "@rydar/shared";

export type PlatformFeesPaths = {
  /** Lien « Régler » (bandeau, alertes) : la carte du compte */
  account: string;
  /** Page qui affiche la carte (pas de bandeau dessus) */
  page: string;
  /** Relevé mensuel */
  statement: string;
  /** Libellé du lien retour du relevé */
  back: string;
  /** Nom des frais dans le bandeau et les alertes : « Frais plateforme » (centrale), « Frais Rydar » (flotte, comme le menu) */
  label: string;
};

export function platformFeesPaths(model: DispatchModel | null | undefined): PlatformFeesPaths {
  return model === "centrale"
    ? {
        account: "/dashboard/settlements#frais-plateforme",
        page: "/dashboard/settlements",
        statement: "/dashboard/settlements/rydar",
        back: "Encaissements",
        label: "Frais plateforme",
      }
    : { account: "/dashboard/rydar", page: "/dashboard/rydar", statement: "/dashboard/rydar/releve", back: "Frais Rydar", label: "Frais Rydar" };
}

/** Export CSV du relevé (même route pour les deux modèles : org_platform_statement contrôle le rôle). */
export const PLATFORM_STATEMENT_EXPORT = "/dashboard/settlements/rydar/export";

/** Pages qui montrent le compte ou le relevé : relues à chaque « platform.updated ». */
export const isPlatformFeesPath = (pathname: string) =>
  pathname.startsWith("/dashboard/settlements") || pathname === "/dashboard/rydar" || pathname.startsWith("/dashboard/rydar/");
