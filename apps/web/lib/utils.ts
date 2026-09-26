import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * onSubmit qui passe les FormData au gestionnaire. À préférer à `<form action={fn}>` : React 19 remet alors
 * le formulaire à zéro après chaque envoi, même quand le serveur répond par une erreur (saisie perdue).
 */
export function submitWith(handler: (data: FormData, form: HTMLFormElement) => void) {
  return (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handler(new FormData(event.currentTarget), event.currentTarget);
  };
}

export function absoluteUrl(path = "/") {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return new URL(path, base).toString();
}
