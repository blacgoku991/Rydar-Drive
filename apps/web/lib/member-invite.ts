import "server-only";
// Accès de gestion (owner, admin, dispatcher) donné à une adresse e-mail : tableau de bord (Équipe) et super admin
// (création de centrale, « Donner un accès »).
// Un compte EXISTANT n'est jamais rattaché directement : son mot de passe peut être connu d'un tiers (compte créé avec
// l'adresse d'autrui par un lien d'inscription ou une autre centrale). L'adhésion est créée « invited » (aucun accès,
// profil non visible) et un lien est envoyé à l'adresse : la personne l'active elle-même sur /auth/set-password
// (accept_member_invitations, session ouverte par ce lien seulement).
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/** Échappe \ % _ : ilike devient une égalité exacte insensible à la casse (aucun joker). */
export const likeExact = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Compte existant pour cette adresse (égalité exacte, insensible à la casse), sinon null. */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const { data } = await createAdminClient().from("users").select("id").ilike("email", likeExact(email)).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * E-mail « choisir son mot de passe » (modèle « Reset password » de Supabase, flux implicite : jetons dans le fragment)
 * vers /auth/set-password, où l'invitation est activée. false : envoi refusé (SMTP, limite d'une demande par minute…).
 */
export async function sendMemberInvitationEmail(email: string): Promise<boolean> {
  const auth = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit" },
  });
  const { error } = await auth.auth.resetPasswordForEmail(email, { redirectTo: `${env.appUrl}/auth/set-password` });
  // Journal serveur seulement (jamais l'adresse complète ni de jeton)
  if (error) console.error(`[member-invite] ${error.status ?? ""} ${error.code ?? ""} ${error.message}`);
  return !error;
}

/** Message d'un envoi d'invitation qui n'a pas pu partir. */
export const INVITATION_EMAIL_FAILED =
  "Invitation enregistrée, mais l'e-mail n'a pas pu partir : utilisez « Renvoyer l'invitation » dans une minute.";
