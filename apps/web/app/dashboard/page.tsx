import type { PricingRule } from "@rydar/shared";
import type { Metadata } from "next";
import { CommandCenter } from "@/components/command/command-center";
import { requireOrg } from "@/lib/auth";
import { getLiveSnapshot } from "@/lib/queries/live";

export const metadata: Metadata = { title: "Command center" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const ctx = await requireOrg();
  const [snapshot, pricing, settings] = await Promise.all([
    getLiveSnapshot(ctx.supabase, ctx.org.id),
    ctx.supabase
      .from("pricing_rules")
      .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end, fixed_fares")
      .eq("organization_id", ctx.org.id)
      .eq("is_active", true),
    ctx.supabase.from("organization_settings").select("offer_timeout_seconds, default_payment_method, location_max_age_seconds").eq("organization_id", ctx.org.id).maybeSingle(),
  ]);
  return (
    <CommandCenter
      initial={snapshot}
      orgName={ctx.org.name}
      pricing={(pricing.data ?? []) as PricingRule[]}
      offerTimeout={settings.data?.offer_timeout_seconds ?? 30}
      locationMaxAgeS={settings.data?.location_max_age_seconds ?? 180}
      defaultPayment={settings.data?.default_payment_method ?? "card"}
    />
  );
}
