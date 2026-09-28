"use client";
// « Page précédente » de la page 404 (app/not-found.tsx) : retour dans l'historique ; arrivée directe (nouvel onglet,
// adresse saisie) : accueil du site consulté.
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function NotFoundBack() {
  return (
    <Button variant="secondary" onClick={() => (window.history.length > 1 ? window.history.back() : window.location.assign("/"))}>
      <ArrowLeft /> Page précédente
    </Button>
  );
}
