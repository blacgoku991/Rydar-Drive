"use server";
import { bookingSiteSchema, describeError, humanizeError } from "@rydar/shared";
import { createHash } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isAdminRole } from "@/lib/auth";
import { actionError } from "@/lib/errors";
import { getOrgContext } from "@/lib/org-context";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string };

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
  const parsed = bookingSiteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeError(parsed.error, BOOKING_LABELS) };
  const v = parsed.data;
  const { error } = await ctx.supabase
    .from("booking_sites")
    .update({ ...v, email: v.email || null, custom_domain: v.custom_domain || null })
    .eq("organization_id", ctx.org.id);
  if (error) return { ok: false, error: error.code === "23505" ? "Ce sous-domaine ou domaine est déjà utilisé." : humanizeError(error.message, actionError(error)) };
  revalidatePath("/dashboard/booking-site");
  return { ok: true };
}

/** Vérifie l'enregistrement TXT _rydar.{domaine} puis active le domaine personnalisé. */
export async function verifyCustomDomain(): Promise<Result> {
  const ctx = await getOrgContext();
  if (!ctx || !isAdminRole(ctx.role)) return { ok: false, error: "Réservé aux administrateurs." };
  const { data: site } = await ctx.supabase.from("booking_sites").select("custom_domain").eq("organization_id", ctx.org.id).single();
  const domain = site?.custom_domain as string | null;
  if (!domain) return { ok: false, error: "Aucun domaine personnalisé." };
  const token = await domainToken(ctx.org.id);
  const records = await resolveTxt(`_rydar.${domain}`).catch(() => [] as string[][]);
  if (!records.some((r) => r.join("") === token)) return { ok: false, error: `Enregistrement TXT introuvable sur _rydar.${domain}.` };
  await createAdminClient().from("booking_sites").update({ custom_domain_verified_at: new Date().toISOString() } as never).eq("organization_id", ctx.org.id);
  await audit({ organizationId: ctx.org.id, actorUserId: ctx.user.id, action: "booking_site.domain_verified", metadata: { domain } });
  revalidatePath("/dashboard/booking-site");
  return { ok: true };
}
