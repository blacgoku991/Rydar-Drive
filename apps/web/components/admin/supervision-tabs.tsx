// Super admin : rubriques de « Supervision » (docs/REFONTE-PANELS.md, R2). Une seule entrée du menu pour les quatre
// journaux techniques ; chacune de leurs pages porte ces onglets dans son en-tête (FilterTabs « rubriques » : liens sans
// préchargement, onglet affiché en aria-current="page"). Les adresses ne changent pas.
import { FilterTabs } from "@/components/ui/filter-tabs";

export type SupervisionTab = "dispatch" | "notifications" | "emails" | "audit";

const TABS: { key: SupervisionTab; href: string; label: string }[] = [
  { key: "dispatch", href: "/admin/dispatch", label: "Dispatch & erreurs" },
  { key: "notifications", href: "/admin/notifications", label: "Notifications" },
  { key: "emails", href: "/admin/emails", label: "E-mails" },
  { key: "audit", href: "/admin/audit", label: "Sécurité & audit" },
];

/** Adresses qui rendent active l'entrée « Supervision » du menu (elle-même mène à la première rubrique). */
export const SUPERVISION_MATCH = TABS.slice(1).map((t) => t.href);

export function SupervisionTabs({ current }: { current: SupervisionTab }) {
  return (
    <FilterTabs
      variant="rubriques"
      label="Rubriques de la supervision"
      items={TABS.map((t) => ({ href: t.href, label: t.label, active: t.key === current }))}
    />
  );
}
