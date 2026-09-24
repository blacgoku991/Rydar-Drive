import "server-only";
import type { PricingRule } from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function getPricing(supabase: SupabaseClient, orgId: string): Promise<PricingRule[]> {
  const { data } = await supabase
    .from("pricing_rules")
    .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end, fixed_fares")
    .eq("organization_id", orgId)
    .eq("is_active", true);
  return (data ?? []) as PricingRule[];
}
