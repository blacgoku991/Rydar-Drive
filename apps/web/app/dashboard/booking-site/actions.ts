"use server";
import { bookingSiteSchema, bookingSiteSchemaFor, describeError, extractErrorCode, humanizeError } from "@rydar/shared";
import { createHash } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { env } from "@/lib/env";
import { actionError } from "@/lib/errors";
import { getOrgContext } from "@/lib/org-context";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string };

/** Mini-sites coupés par la plateforme (super admin) : réglages figés, la base refuse aussi (BOOKING_SITES_DISABLED). */
const SWITCHED_OFF = (): Result => ({ ok: false, error: humanizeError("BOOKING_SITES_DISABLED") });

/** Domaine racine de Rydar, ses sous-domaines ou l'hôte de l'application : jamais un domaine personnalisé. */
function isPlatformDomain(domain: string) {
  const root = env.rootDomain.toLowerCase();
  return domain === root || domain.endsWith(`.${root}`) || domain === new URL(env.appUrl).hostname.toLowerCase();
}

const PLATFORM_DOMAIN_ERROR = () =>
  `Le domaine personnalisé ne peut pas être ${env.rootDomain} ni l'un de ses sous-domaines : utilisez le champ « Sous-domaine ».`;

/** Noms des champs du mini-site pour les messages d'erreur. */
const BOOKING_LABELS: Record<string, string> = {
  subdomain: "Sous-domaine", custom_domain: "Domaine personnalisé", title: "Titre", tagline: "Accroche", description: "Description",
  logo_url: "Logo", hero_image_url: "Image d'en-tête", primary_color: "Couleur principale", phone: "Téléphone", email: "E-mail",
  whatsapp: "WhatsApp", service_area: "Zone desservie", vehicle_categories: "Catégories de véhicules",
};

export async function domainToken(orgId: string) {
  return `rydar-verify=${createHash("sha256").update(`rydar:${orgId}`).digest("hex").slice(0, 24)}`;
}

export async function updateBookingSite(input: z.input<typeof bookingSiteSchema>): Promise<Result> {
  const ctx = await getOrgContext();
  if (!ctx || !isAdminRole(ctx.role)) return { ok: false, error: "Réservé aux administrateurs." };
  if (!(await bookingSitesEnabled())) return SWITCHED_OFF();
  // Nom réservé refusé seulement s'il CHANGE (comme le trigger SQL) : un sous-domaine réservé pris avant la règle
  // n'empêche pas d'enregistrer les autres réglages
  const { data: current, error: readError } = await ctx.supabase
    .from("booking_sites")
    .select("subdomain")
    .eq("organization_id", ctx.org.id)
    .single();
  if (readError) return { ok: false, error: humanizeError(readError.message, actionError(readError)) };
  const parsed = bookingSiteSchemaFor((current as { subdomain: string | null } | null)?.subdomain).safeParse(input);
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, BOOKING_LABELS) };
  const v = parsed.data;
  if (v.custom_domain && isPlatformDomain(v.custom_domain)) return { ok: false, error: PLATFORM_DOMAIN_ERROR() };
  const { error } = await ctx.supabase
    .from("booking_sites")
    .update({ ...v, email: v.email || null, custom_domain: v.custom_domain || null })
    .eq("organization_id", ctx.org.id);
  if (error) {
    // Seuls les domaines VÉRIFIÉS sont uniques (migration 20260924005000) : un conflit ne peut venir que du sous-domaine
    if (error.code === "23505") return { ok: false, error: "Ce sous-domaine est déjà utilisé : choisissez-en un autre." };
    if (extractErrorCode(error.message) === "SUBDOMAIN_CHANGE_LIMIT") {
      return { ok: false, error: "Sous-domaine déjà modifié 5 fois ces 7 derniers jours : réessayez plus tard ou contactez l'équipe Rydar." };
    }
    return { ok: false, error: humanizeError(error.message, actionError(error)) };
  }
  revalidatePath("/dashboard/booking-site");
  return { ok: true };
}

/** Vérifie l'enregistrement TXT _rydar.{domaine} puis active le domaine personnalisé. */
export async function verifyCustomDomain(): Promise<Result> {
  const ctx = await getOrgContext();
  if (!ctx || !isAdminRole(ctx.role)) return { ok: false, error: "Réservé aux administrateurs." };
  if (!(await bookingSitesEnabled())) return SWITCHED_OFF();
  const { data: site } = await ctx.supabase.from("booking_sites").select("custom_domain").eq("organization_id", ctx.org.id).single();
  const domain = site?.custom_domain as string | null;
  if (!domain) return { ok: false, error: "Aucun domaine personnalisé." };
  if (isPlatformDomain(domain)) return { ok: false, error: PLATFORM_DOMAIN_ERROR() };
  const token = await domainToken(ctx.org.id);
  const records = await resolveTxt(`_rydar.${domain}`).catch(() => [] as string[][]);
  // Droit de l'offre, relu juste avant l'écriture (même source que la page : private.org_limits, centrale sans offre =
  // autorisé) : un domaine retiré par l'offre (rétrogradation, surcharge) n'est jamais revérifié d'un clic
  const { data: usage, error: usageError } = await ctx.supabase.rpc("org_usage", { p_org: ctx.org.id });
  if (usageError) return { ok: false, error: "Vérification impossible pour le moment : réessayez." };
  if (!(usage as { limits?: { custom_domain?: boolean } } | null)?.limits?.custom_domain) {
    return { ok: false, error: humanizeError("PLAN_FEATURE_CUSTOM_DOMAIN") };
  }
  if (!records.some((r) => r.join("") === token)) return { ok: false, error: `Enregistrement TXT introuvable sur _rydar.${domain}.` };
  // Atomique : on ne marque vérifié QUE le domaine dont le TXT vient d'être lu (il a pu changer pendant la résolution DNS)
  const { data: verified, error } = await createAdminClient()
    .from("booking_sites")
    .update({ custom_domain_verified_at: new Date().toISOString() } as never)
    .eq("organization_id", ctx.org.id)
    .eq("custom_domain", domain)
    .select("organization_id");
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Ce domaine est déjà vérifié par une autre centrale : contactez l'équipe Rydar si vous en êtes le propriétaire." };
    }
    return { ok: false, error: "Vérification impossible pour le moment : réessayez." };
  }
  if (!verified?.length) return { ok: false, error: "Le domaine a changé pendant la vérification : recommencez." };
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "booking_site.domain_verified", metadata: { domain } });
  revalidatePath("/dashboard/booking-site");
  return { ok: true };
}
