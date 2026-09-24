"use server";
import { cookies } from "next/headers";
import { ORG_COOKIE, requireUser } from "@/lib/auth";

export async function switchOrganization(orgId: string) {
  const session = await requireUser();
  if (!session.memberships.some((m) => m.org.id === orgId)) return;
  const jar = await cookies();
  jar.set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  await session.supabase.from("users").update({ last_active_org_id: orgId }).eq("id", session.user.id);
}
