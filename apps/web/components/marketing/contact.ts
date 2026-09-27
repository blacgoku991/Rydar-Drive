import { env } from "@/lib/env";

/** Contact commercial : contact@ le domaine de la plateforme. */
export const CONTACT_EMAIL = `contact@${env.rootDomain}`;

/** Lien « écrire au contact commercial » avec un objet prérempli. */
export const mailto = (subject: string) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;

export const DEMO_HREF = mailto("Démo Rydar Drive");
