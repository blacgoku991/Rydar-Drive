import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

/**
 * Échange du code PKCE (réinitialisation / invitation) contre une session.
 * Redirection par chemin RELATIF (en-tête Location sans hôte, résolu par le navigateur sur le site du lien) : derrière
 * Caddy, l'adresse de la requête vue par le serveur Next autonome est son adresse interne (https://0.0.0.0:3000), où
 * le lien « Mot de passe oublié » renvoyait. Les cookies de la session ouverte ici partent avec la redirection.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) redirect(next);
  }
  redirect("/login?error=link");
}
