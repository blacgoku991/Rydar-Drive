"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";

/**
 * Confirmation d'une action sensible (docs/REFONTE-PANELS.md § 3.7) : révoquer une clé, retirer un accès, déconnecter,
 * suspendre… Titre en question, conséquence en une phrase VÉRIFIÉE dans le code (jamais inventée), bouton qui nomme
 * l'action (« Révoquer la clé », jamais « OK ») ; « Retour » ferme sans rien faire. Champs propres à l'action (motif
 * obligatoire…) en `children`. Ton `danger` (coupe un accès) ou `primary`. Fenêtre contrôlée (`open`, `onOpenChange`) :
 * l'appelant la ferme après le succès de l'action et la garde ouverte en cas d'échec.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  onConfirm,
  tone = "danger",
  loading = false,
  confirmDisabled = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Question (« Révoquer la clé « Site web » ? ») */
  title: string;
  /** Conséquence en une phrase (« Votre site ne pourra plus envoyer de réservations. ») */
  consequence: React.ReactNode;
  /** Verbe + objet (« Révoquer la clé ») */
  confirmLabel: string;
  onConfirm: () => void;
  tone?: "danger" | "primary";
  loading?: boolean;
  /** Action impossible tant qu'un champ requis est vide (motif…) */
  confirmDisabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title={title} description={consequence}>
        {children}
        <DialogFooter backDisabled={loading}>
          <Button type="button" variant={tone === "danger" ? "danger" : "primary"} loading={loading} disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
