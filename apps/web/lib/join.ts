// Inscription publique d'un chauffeur par le lien d'une centrale, sans connexion : page /rejoindre/{code}
// (action serveur) et application chauffeur (POST /api/join/{code}) partagent cette logique.
// Ordre : validation → limitation de débit → lien valide → identité bannie / doublon → compte Auth →
// candidature (svc_driver_apply) ; échec de la candidature → le compte Auth créé est supprimé.
import "server-only";
import { fieldErrors, joinApplicationSchema, type DriverApplyResult, type IdentityCheck, type JoinInfo } from "@rydar/shared";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

export type JoinResult =
  | { ok: true; status: "PENDING" | "APPROVED"; organizationName: string; email: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export const JOIN_CODE_RE = /^[a-z0-9]{10,32}$/;
/** Refus volontairement neutre (identité bannie) : on ne dit pas pourquoi. */
const NEUTRAL_REFUSAL = "Inscription impossible. Contactez la centrale.";
const LINK_INACTIVE = "Ce lien d'inscription n'est plus actif. Demandez un nouveau lien à la centrale.";

const DUPLICATE: Record<NonNullable<IdentityCheck["duplicate"]>, { field: string; message: string }> = {
  phone: { field: "phone", message: "Ce numéro est déjà inscrit dans cette centrale : connectez-vous à l'application avec votre compte." },
  email: { field: "email", message: "Cette adresse e-mail est déjà inscrite dans cette centrale." },
  plate: { field: "vehicle.plate", message: "Cette plaque est déjà enregistrée dans cette centrale." },
};

export async function applyWithJoinLink(code: string, input: z.input<typeof joinApplicationSchema>): Promise<JoinResult> {
  const joinCode = String(code ?? "").trim().toLowerCase();
  if (!JOIN_CODE_RE.test(joinCode)) return { ok: false, error: LINK_INACTIVE };

  // Piège à robots : champ caché rempli → faux succès, rien n'est créé
  if (typeof input?.website === "string" && input.website.trim() !== "") {
    return { ok: true, status: "PENDING", organizationName: "la centrale", email: "" };
  }
  const parsed = joinApplicationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Vérifiez les champs signalés.", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;

  // Limitation de débit : par adresse IP et par e-mail
  const ip = await clientIp();
  const [byIp, byEmail] = await Promise.all([rateLimit(`join:ip:${ip}`, 8, 900), rateLimit(`join:email:${v.email}`, 4, 3600)]);
  if (!byIp.ok || !byEmail.ok) return { ok: false, error: "Trop de tentatives. Réessayez dans quelques minutes ou contactez la centrale." };

  const admin = createAdminClient();
  const { data: infoData } = await admin.rpc("svc_join_info", { p_code: joinCode });
  const info = infoData as JoinInfo | null;
  if (!info?.ok || !info.organization) return { ok: false, error: LINK_INACTIVE };
  const org = info.organization;

  // Identité bannie (centrale ou plateforme) ? Déjà inscrit dans cette centrale ?
  const { data: checkData, error: checkError } = await admin.rpc("svc_identity_check", {
    p_org: org.id,
    p_phone: v.phone,
    p_email: v.email,
    p_vtc_card: v.vtcCardNumber ?? null,
    p_plate: v.vehicle.plate,
  });
  if (checkError || !checkData) return { ok: false, error: "Inscription momentanément indisponible. Réessayez dans un instant." };
  const check = checkData as IdentityCheck;
  if (check.banned) {
    await audit({
      organizationId: org.id,
      actorType: "system",
      action: "driver.join_refused",
      entityType: "organizations",
      entityId: org.id,
      severity: "warning",
      metadata: { reason: "identity_banned", via: "join_link" },
    });
    return { ok: false, error: NEUTRAL_REFUSAL };
  }
  if (check.duplicate) {
    const d = DUPLICATE[check.duplicate];
    return { ok: false, error: d.message, fieldErrors: { [d.field]: d.message } };
  }

  // Compte de connexion (application chauffeur : e-mail + mot de passe)
  const created = await admin.auth.admin.createUser({
    email: v.email,
    password: v.password,
    email_confirm: true,
    user_metadata: { full_name: `${v.firstName} ${v.lastName}`, phone: v.phone, kind: "driver" },
  });
  if (created.error || !created.data.user) {
    const msg = created.error?.message ?? "";
    if (/already|exists|registered/i.test(msg)) {
      const m = "Cette adresse est déjà liée à un compte Rydar Drive : utilisez une autre adresse e-mail.";
      return { ok: false, error: m, fieldErrors: { email: m } };
    }
    if (/password/i.test(msg)) return { ok: false, error: "Mot de passe refusé : choisissez-en un plus solide.", fieldErrors: { password: "Mot de passe trop faible" } };
    return { ok: false, error: "Création du compte impossible pour le moment. Réessayez." };
  }
  const userId = created.data.user.id;

  const { data: applyData, error: applyError } = await admin.rpc("svc_driver_apply", {
    p_org: org.id,
    p_user_id: userId,
    p_first_name: v.firstName,
    p_last_name: v.lastName,
    p_phone: v.phone,
    p_email: v.email,
    p_vtc_card: v.vtcCardNumber ?? null,
    p_vehicle: {
      brand: v.vehicle.brand ?? null,
      model: v.vehicle.model,
      color: v.vehicle.color ?? null,
      plate: v.vehicle.plate,
      category: v.vehicle.category,
      seats: v.vehicle.seats,
      luggage_capacity: v.vehicle.luggageCapacity,
    },
    p_message: v.message ?? null,
  });
  const res = applyData as DriverApplyResult | null;
  if (applyError || !res?.ok) {
    // Compensation : pas de compte orphelin sans candidature
    await admin.auth.admin.deleteUser(userId).catch(() => null);
    switch (res?.code) {
      case "PHONE_TAKEN":
        return { ok: false, error: DUPLICATE.phone.message, fieldErrors: { phone: DUPLICATE.phone.message } };
      case "PLATE_TAKEN":
        return { ok: false, error: DUPLICATE.plate.message, fieldErrors: { "vehicle.plate": DUPLICATE.plate.message } };
      case "EMAIL_TAKEN":
        return { ok: false, error: DUPLICATE.email.message, fieldErrors: { email: DUPLICATE.email.message } };
      case "IDENTITY_BANNED":
        return { ok: false, error: NEUTRAL_REFUSAL };
      case "JOIN_DISABLED":
        return { ok: false, error: LINK_INACTIVE };
      case "INVALID_FORM":
        return { ok: false, error: "Vérifiez le formulaire (nom, téléphone, e-mail, modèle et plaque du véhicule)." };
      case "ALREADY_REGISTERED":
        return { ok: false, error: "Ce compte est déjà rattaché à une centrale." };
      default:
        return { ok: false, error: res?.message ?? "Inscription impossible pour le moment. Réessayez." };
    }
  }

  await audit({
    organizationId: org.id,
    actorType: "system",
    action: "driver.join_link_signup",
    entityType: "drivers",
    entityId: res.driver_id,
    metadata: { status: res.code, auto_approved: res.code === "APPROVED", email: v.email, driver_number: res.number ?? null },
  });
  return { ok: true, status: res.code === "APPROVED" ? "APPROVED" : "PENDING", organizationName: res.organization?.name ?? org.name, email: v.email };
}

/** Centrale derrière un code d'inscription (null : lien invalide ou désactivé). */
export async function loadJoinInfo(raw: string): Promise<JoinInfo | null> {
  const code = String(raw ?? "").trim().toLowerCase();
  if (!JOIN_CODE_RE.test(code)) return null;
  const { data } = await createAdminClient().rpc("svc_join_info", { p_code: code });
  const info = data as JoinInfo | null;
  return info?.ok && info.organization ? info : null;
}
