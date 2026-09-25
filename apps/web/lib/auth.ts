import "server-only";
import type { DispatchModel, OrgRole } from "@rydar/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export const ORG_COOKIE = "rd_org";

export type OrgSummary = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended" | "archived";
  logo_url: string | null;
  timezone: string;
  plan_id: string | null;
  /** Modèle d'exploitation choisi par le super admin : flotte (option 1) ou centrale à commission (option 2) */
  dispatch_model: DispatchModel;
};

export type SessionContext = Awaited<ReturnType<typeof loadSession>>;

async function loadSession() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: profile }, { data: memberships }, { data: driver }] = await Promise.all([
    supabase.from("users").select("id, email, full_name, avatar_url, is_super_admin, last_active_org_id").eq("id", user.id).maybeSingle(),
    supabase
      .from("organization_users")
      .select("organization_id, role, organization:organizations(id, name, slug, status, logo_url, timezone, plan_id, dispatch_model)")
      .eq("user_id", user.id)
      .eq("status", "active"),
    supabase.from("drivers").select("id, first_name").eq("user_id", user.id).maybeSingle(),
  ]);

  const orgs = (memberships ?? [])
    .map((m) => ({ role: m.role as OrgRole, org: m.organization as unknown as OrgSummary }))
    .filter((m) => m.org && m.org.status !== "archived");

  return {
    supabase,
    user,
    profile: profile ?? { id: user.id, email: user.email ?? "", full_name: null, avatar_url: null, is_super_admin: false, last_active_org_id: null },
    memberships: orgs,
    isDriver: !!driver,
  };
}

export const getSession = cache(loadSession);

export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireSuperAdmin() {
  const session = await requireUser();
  if (!session.profile.is_super_admin) redirect("/dashboard");
  return session;
}

/** Organisation active (cookie → dernière utilisée → première). */
export async function requireOrg(opts: { roles?: OrgRole[] } = {}) {
  const session = await requireUser();
  if (!session.memberships.length) {
    if (session.profile.is_super_admin) redirect("/admin");
    if (session.isDriver) redirect("/driver-app");
    redirect("/no-access");
  }
  const jar = await cookies();
  const wanted = jar.get(ORG_COOKIE)?.value ?? session.profile.last_active_org_id;
  const current = session.memberships.find((m) => m.org.id === wanted) ?? session.memberships[0]!;
  if (current.org.status === "suspended") redirect("/suspended");
  if (opts.roles && !opts.roles.includes(current.role)) redirect("/dashboard?forbidden=1");
  return { ...session, org: current.org, role: current.role };
}

export function isAdminRole(role: OrgRole) {
  return role === "owner" || role === "admin";
}
