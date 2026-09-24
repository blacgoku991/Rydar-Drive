import { AdminShell } from "@/components/shell/admin-shell";
import { requireSuperAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSuperAdmin();
  return <AdminShell user={{ name: session.profile.full_name ?? "Super admin", email: session.profile.email }}>{children}</AdminShell>;
}
