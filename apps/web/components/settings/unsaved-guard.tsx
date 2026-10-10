"use client";
// Saisie non enregistrée (lib/use-unsaved-guard.ts) : la fenêtre qui retient un changement d'onglet ou de page. Placée
// dans le formulaire concerné ; rien n'est retenu tant que `dirty` est faux.
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";

const NB = " ";

export function UnsavedGuard({ dirty }: { dirty: boolean }) {
  const { pendingHref, stay, leave } = useUnsavedGuard(dirty);
  return (
    <ConfirmDialog
      open={!!pendingHref}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
      title={`Quitter sans enregistrer${NB}?`}
      consequence={`Vos modifications ne sont pas enregistrées${NB}: elles seront perdues. «${NB}Retour${NB}» vous ramène au formulaire.`}
      confirmLabel="Quitter sans enregistrer"
      onConfirm={leave}
    />
  );
}
