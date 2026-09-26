import type { Metadata } from "next";
import { LiveConsole } from "@/components/admin/live-console";
import type { AdminLiveSnapshot } from "@/components/admin/live-types";
import { getPlatformLive } from "@/components/admin/platform-data";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Carte en direct" };
export const dynamic = "force-dynamic";

/** Tous les chauffeurs en ligne de la plateforme, par organisation (flottes et centrales). */
export default async function AdminLiveMapPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const session = await requireSuperAdmin();
  const { org } = await searchParams;
  let initial: AdminLiveSnapshot;
  try {
    initial = await getPlatformLive(session.supabase);
  } catch (err) {
    // la carte s'affiche quand même ; le rafraîchissement (5 s) prendra le relais
    console.error("[admin/carte]", err);
    initial = { orgs: [], drivers: [], rides: [], offers: [], serverTime: new Date().toISOString() };
  }
  const initialOrg = org && initial.orgs.some((o) => o.id === org) ? org : null;
  return <LiveConsole initial={initial} initialOrg={initialOrg} />;
}
