import { formatRelative, type AdminPlatformOverview } from "@rydar/shared";
import type { Metadata } from "next";
import { BookingSitesSwitchCard } from "@/components/admin/booking-sites-switch";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { BillingCard } from "@/components/platform-fees/admin-billing";
import { PlatformWhatsAppCard } from "@/components/platform-fees/admin-whatsapp";
import { Callout } from "@/components/ui/callout";
import type { WhatsAppRow } from "@/components/whatsapp/whatsapp-card";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Réglages de la plateforme" };
export const dynamic = "force-dynamic";

/**
 * Réglages de la plateforme (docs/REFONTE-PANELS.md, R2) : ce qui se règle une fois pour toute la plateforme, réuni sur
 * une page. Mêmes lectures et mêmes actions qu'avant le déplacement : coordonnées de paiement (admin_platform_overview,
 * comme « Frais Rydar »), WhatsApp de Rydar (platform_whatsapp, jamais le jeton), interrupteur des mini-sites (comme
 * « Offres & limites »).
 */
export default async function PlatformSettingsPage() {
  const session = await requireSuperAdmin();
  const db = session.supabase;
  const [overview, { data: whatsapp, error: whatsappError }, { data: platform, error: platformError }, sites] = await Promise.all([
    db.rpc("admin_platform_overview"),
    // RLS : super admin (le jeton d'accès n'est jamais lisible)
    db
      .from("platform_whatsapp")
      .select("phone_number_id, display_phone, verified_name, template, language, enabled, sent_count, last_sent_at, last_error, last_error_at")
      .maybeSingle(),
    // Interrupteur plateforme des mini-sites (lecture RLS du super admin) ; absent = coupé, comme la base
    db.from("platform_settings").select("booking_sites_enabled, updated_at").maybeSingle(),
    // Mini-sites activés par une centrale ACTIVE (réglage conservé pendant une coupure) : seuls ceux-là sont servis
    // (resolve_booking_host, /book) ; centrales suspendues ou archivées non comptées
    db
      .from("booking_sites")
      .select("organization_id, org:organizations!inner(status)", { count: "exact", head: true })
      .eq("enabled", true)
      .eq("org.status", "active"),
  ]);
  if (overview.error) console.error("[admin/reglages] coordonnées de paiement illisibles", overview.error.message);
  if (whatsappError) console.error("[admin/reglages] WhatsApp de Rydar illisible", whatsappError.message);
  if (platformError) console.error("[admin/reglages] interrupteur des mini-sites illisible", platformError.message);
  const billing = ((overview.data ?? null) as AdminPlatformOverview | null)?.billing ?? null;
  const switchState = (platform ?? null) as { booking_sites_enabled: boolean; updated_at: string } | null;
  const sitesOn = switchState?.booking_sites_enabled === true;

  return (
    <>
      <PageHeader
        title="Réglages de la plateforme"
        description="Coordonnées de paiement de Rydar, WhatsApp de Rydar et interrupteur des mini-sites."
      />
      {/* Bureau : coordonnées et mini-sites à gauche, WhatsApp (plus long) à droite ; téléphone : dans cet ordre */}
      <PageBody className="grid items-start gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-6">
          {billing ? (
            <BillingCard billing={billing} />
          ) : (
            <Callout tone="danger" title={"Coordonnées de paiement\u00a0: lecture impossible, réessayez dans un instant."} />
          )}
          {/* Lecture impossible : aucun bouton (un état supposé pourrait faire basculer tous les mini-sites à tort) */}
          {platformError ? (
            <Callout tone="danger" title={"Mini-sites de réservation\u00a0: lecture impossible, réessayez dans un instant."} />
          ) : (
            <BookingSitesSwitchCard
              enabled={sitesOn}
              configured={sites.error ? null : (sites.count ?? 0)}
              updatedLabel={switchState?.updated_at ? formatRelative(switchState.updated_at) : null}
            />
          )}
        </div>
        <div className="min-w-0">
          {whatsappError ? (
            <Callout tone="danger" title={"WhatsApp de Rydar\u00a0: lecture impossible, réessayez dans un instant."} />
          ) : (
            <PlatformWhatsAppCard row={(whatsapp ?? null) as WhatsAppRow | null} />
          )}
        </div>
      </PageBody>
    </>
  );
}
