"use client";
// Super admin — « Nouveau client » (docs/REFONTE-PANELS.md, R3) : un seul bouton de création sur la liste des clients.
// La fenêtre « Quel type de client ? » ouvre le formulaire du type choisi : Flotte ou Centrale à commission
// (CreateOrganizationSheet, type présélectionné), Flotte Privée (CreatePrivateFleetSheet). Formulaires, champs et
// actions serveur inchangés ; chaque choix ouvre un formulaire vierge.
import { DISPATCH_MODEL_META, type DispatchModel } from "@rydar/shared";
import { ChevronRight, Network, Plus, Sparkles, Truck } from "lucide-react";
import { useId, useState } from "react";
import { CreateOrganizationSheet } from "@/components/admin/admin-widgets";
import { CreatePrivateFleetSheet, type PlanOption } from "@/components/admin/private-fleet";
import { frSpaces } from "@/components/platform-fees/org-platform-format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";

type ClientType = DispatchModel | "private";

const TYPES: { type: ClientType; title: string; description: string; Icon: typeof Truck }[] = [
  { type: "fleet", title: DISPATCH_MODEL_META.fleet.label, description: frSpaces(DISPATCH_MODEL_META.fleet.description), Icon: Truck },
  { type: "centrale", title: DISPATCH_MODEL_META.centrale.label, description: frSpaces(DISPATCH_MODEL_META.centrale.description), Icon: Network },
  { type: "private", title: "Flotte Privée", description: "Un chauffeur seul, avec son propre site de réservation.", Icon: Sparkles },
];

export function NewClientButton({
  plans,
  privateFleetPlans,
  rootDomain,
}: {
  /** Offres actives proposées à une flotte ou une centrale (code, nom) */
  plans: { code: string; name: string }[];
  /** Mêmes offres pour la Flotte Privée (celles sans API sont proposées grisées) */
  privateFleetPlans: PlanOption[];
  /** NEXT_PUBLIC_ROOT_DOMAIN (adresse du client : identifiant.domaine) */
  rootDomain: string;
}) {
  const uid = useId();
  const [choosing, setChoosing] = useState(false);
  // Formulaire ouvert : son type et une clé nouvelle à chaque choix (formulaire vierge), gardée à la fermeture (animation)
  const [form, setForm] = useState<{ type: ClientType; key: number } | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const choose = (type: ClientType) => {
    setChoosing(false);
    setForm((f) => ({ type, key: (f?.key ?? 0) + 1 }));
    setFormOpen(true);
  };

  return (
    <>
      <Button variant="primary" data-tour="sa-new-client" onClick={() => setChoosing(true)}>
        <Plus /> Nouveau client
      </Button>
      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent title={"Quel type de client\u00a0?"} description="Le formulaire de création dépend du type choisi.">
          <ul className="space-y-2.5">
            {TYPES.map(({ type, title, description, Icon }) => (
              <li key={type}>
                <button
                  type="button"
                  onClick={() => choose(type)}
                  // Nom accessible stable (recette : « Nouveau client Flotte Privée »), description lue à la suite
                  aria-label={`Nouveau client ${title}`}
                  aria-describedby={`${uid}-${type}`}
                  className="flex w-full items-start gap-3 rounded-xl border border-line p-4 text-left transition-colors hover:border-line-strong hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                >
                  <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-strong bg-ink-700 text-fg-muted [&_svg]:size-4">
                    <Icon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold text-fg">{title}</span>
                    <span id={`${uid}-${type}`} className="mt-0.5 block text-[13px] leading-relaxed text-fg-muted">
                      {description}
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="mt-2.5 size-4 shrink-0 text-fg-subtle" />
                </button>
              </li>
            ))}
          </ul>
          <DialogFooter />
        </DialogContent>
      </Dialog>
      {form && form.type !== "private" && (
        <CreateOrganizationSheet
          key={form.key}
          plans={plans}
          rootDomain={rootDomain}
          initialModel={form.type}
          open={formOpen}
          onOpenChange={setFormOpen}
        />
      )}
      {form?.type === "private" && (
        <CreatePrivateFleetSheet key={form.key} plans={privateFleetPlans} rootDomain={rootDomain} open={formOpen} onOpenChange={setFormOpen} />
      )}
    </>
  );
}
