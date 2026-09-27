import "server-only";
import { cookies } from "next/headers";
import { ORG_COOKIE, getSession, pickMembership } from "@/lib/auth";

/** Variante « route handler » de requireOrg : renvoie null au lieu de rediriger. */
export async function getOrgContext() {
  const session = await getSession();
  if (!session || !session.memberships.length) return null;
  const jar = await cookies();
  const wanted = jar.get(ORG_COOKIE)?.value ?? session.profile.last_active_org_id;
  const current = pickMembership(session.memberships, wanted);
  if (current.org.status !== "active") return null;
  return { ...session, org: current.org, role: current.role };
}
