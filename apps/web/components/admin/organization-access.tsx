"use client";
// Super admin : accès au tableau de bord d'un compte (propriétaires, administrateurs, dispatchers).
import { ORG_ROLE_LABELS, formatDate, type OrgRole } from "@rydar/shared";
import { KeyRound, UserPlus, UserX, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { grantOrganizationAccess, setOrganizationMemberStatus } from "@/app/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { cn, submitWith } from "@/lib/utils";

export type AccessMember = {
  id: string;
  role: OrgRole;
  status: "active" | "invited" | "disabled";
  created_at: string;
  user: { full_name: string | null; email: string } | null;
};

const ROLE_HELP: Record<OrgRole, string> = {
  owner: "Tout, y compris facturation et équipe",
  admin: "Réglages, chauffeurs, validations, bannissements",
  dispatcher: "Courses, carte, messages (consultation du réseau)",
};
const ROLE_TONE: Record<OrgRole, "brand" | "blue" | "neutral"> = { owner: "brand", admin: "blue", dispatcher: "neutral" };

export function OrganizationAccessCard({ orgId, orgName, members }: { orgId: string; orgName: string; members: AccessMember[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<OrgRole>("dispatcher");
  const [mode, setMode] = useState<"password" | "invite">("password");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revoke, setRevoke] = useState<AccessMember | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const activeOwners = members.filter((m) => m.role === "owner" && m.status === "active").length;
  const sorted = [...members].sort(
    (a, b) =>
      Number(a.status !== "active") - Number(b.status !== "active") ||
      ["owner", "admin", "dispatcher"].indexOf(a.role) - ["owner", "admin", "dispatcher"].indexOf(b.role) ||
      (a.user?.full_name ?? "").localeCompare(b.user?.full_name ?? ""),
  );

  const setStatus = (m: AccessMember, status: "active" | "disabled") => {
    setBusy(m.id);
    start(async () => {
      const res = await setOrganizationMemberStatus(orgId, m.id, status);
      setBusy(null);
      if (!res.ok) return void toast.error(res.error);
      toast.success(status === "disabled" ? `Accès retiré : ${m.user?.full_name ?? m.user?.email}` : `Accès rétabli : ${m.user?.full_name ?? m.user?.email}`, {
        description: status === "disabled" ? "Sessions fermées sur tous ses appareils." : undefined,
      });
      setRevoke(null);
      router.refresh();
    });
  };

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardHeader
        title="Accès"
        icon={<KeyRound />}
        description="Tableau de bord : propriétaire, administrateurs, dispatchers."
        action={
          <Button variant="primary" size="sm" className="hidden sm:inline-flex" onClick={() => { setErrors({}); setOpen(true); }}>
            <UserPlus /> Donner un accès
          </Button>
        }
      />
      {/* Mobile : bouton pleine largeur sous l'en-tête (l'en-tête garde toute sa largeur pour le texte) */}
      <div className="border-b border-line px-5 py-3 sm:hidden">
        <Button variant="primary" size="sm" className="w-full" onClick={() => { setErrors({}); setOpen(true); }}>
          <UserPlus /> Donner un accès
        </Button>
      </div>
      <ul className="divide-y divide-line">
        {sorted.map((m) => {
          const name = m.user?.full_name ?? m.user?.email ?? "—";
          const disabled = m.status !== "active";
          return (
            <li key={m.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3", disabled && "opacity-70")}>
              <Avatar name={name} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium">{name}</p>
                <p className="truncate text-[12px] text-fg-subtle" title={`Accès depuis le ${formatDate(m.created_at)}`}>{m.user?.email}</p>
              </div>
              <div className="flex w-full items-center gap-2 pl-[44px] sm:w-auto sm:pl-0">
                <Badge tone={ROLE_TONE[m.role]} dot={false}>{ORG_ROLE_LABELS[m.role]}</Badge>
                {disabled && <Badge tone="red">Accès retiré</Badge>}
                {disabled ? (
                  <Button variant="ghost" size="xs" loading={pending && busy === m.id} onClick={() => setStatus(m, "active")}>
                    <Undo2 /> Rétablir
                  </Button>
                ) : (
                  <Button variant="ghost" size="xs" className="text-fg-subtle hover:text-red" onClick={() => setRevoke(m)}>
                    <UserX /> Retirer
                  </Button>
                )}
              </div>
            </li>
          );
        })}
        {!members.length && <li className="px-5 py-6 text-[13px] text-fg-subtle">Aucun compte : donnez un premier accès.</li>}
      </ul>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Donner un accès" description={`Accès au tableau de bord de ${orgName}. Un compte existant (même e-mail) est réutilisé.`}>
          <form
            onSubmit={submitWith((f) =>
              start(async () => {
                const res = await grantOrganizationAccess(orgId, {
                  fullName: String(f.get("fullName") ?? ""),
                  email: String(f.get("email") ?? ""),
                  role,
                  // undefined = invitation par e-mail ; chaîne (même vide) = mot de passe provisoire
                  password: mode === "password" ? String(f.get("password") ?? "") : undefined,
                });
                if (!res.ok) {
                  setErrors(res.fieldErrors ?? {});
                  return void toast.error(res.error);
                }
                toast.success(`Accès ${ORG_ROLE_LABELS[role].toLowerCase()} donné`, {
                  description: res.invited
                    ? "Invitation envoyée par e-mail."
                    : res.created
                      ? "Compte créé : transmettez l'e-mail et le mot de passe provisoire."
                      : res.reactivated
                        ? "Accès rétabli sur le compte existant."
                        : "Compte existant rattaché à ce rattacheur.",
                });
                setOpen(false);
                router.refresh();
              }),
            )}
            className="space-y-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nom complet" error={errors.fullName}>
                <Input name="fullName" required autoComplete="off" aria-invalid={!!errors.fullName} />
              </Field>
              <Field label="E-mail" error={errors.email}>
                <Input name="email" type="email" required autoComplete="off" aria-invalid={!!errors.email} />
              </Field>
            </div>
            <div>
              <p className="mb-1.5 text-[12.5px] font-medium text-fg-muted">Rôle</p>
              <div role="radiogroup" aria-label="Rôle" className="grid gap-2 sm:grid-cols-3">
                {(["owner", "admin", "dispatcher"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={role === r}
                    onClick={() => setRole(r)}
                    className={cn("flex flex-col justify-start rounded-xl border p-3 text-left", role === r ? "border-brand/50 bg-brand/[0.06]" : "border-line hover:border-line-strong")}
                  >
                    <span className={cn("block text-[13px] font-medium", role === r && "text-brand")}>{ORG_ROLE_LABELS[r]}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-subtle">{ROLE_HELP[r]}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[12.5px] font-medium text-fg-muted">Connexion</p>
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-ink-850 p-1">
                {(["password", "invite"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMode(k)}
                    className={cn("h-8 rounded-md text-[12.5px] font-medium", mode === k ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg")}
                  >
                    {k === "password" ? "Mot de passe provisoire" : "Invitation par e-mail"}
                  </button>
                ))}
              </div>
              {mode === "password" ? (
                <Field className="mt-3" error={errors.password} hint="10 caractères minimum — inutile si un compte existe déjà avec cet e-mail.">
                  <Input name="password" type="text" minLength={10} autoComplete="off" className="num" aria-label="Mot de passe provisoire" aria-invalid={!!errors.password} />
                </Field>
              ) : (
                <p className="mt-2 text-[12px] text-fg-subtle">Un lien pour choisir son mot de passe est envoyé à cette adresse (compte existant : accès immédiat).</p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
              <Button type="submit" variant="primary" loading={pending}>Donner l&apos;accès</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)}>
        <DialogContent
          title="Retirer l'accès ?"
          description={revoke ? `${revoke.user?.full_name ?? revoke.user?.email} (${ORG_ROLE_LABELS[revoke.role]}) ne pourra plus ouvrir le tableau de bord de ${orgName} ; ses sessions sont fermées immédiatement.` : undefined}
        >
          {revoke?.role === "owner" && activeOwners <= 1 && (
            <p className="mb-4 rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2.5 text-[12.5px] text-amber">
              C&apos;est le dernier propriétaire actif : donnez d&apos;abord un accès propriétaire à quelqu&apos;un d&apos;autre si le compte doit rester géré.
            </p>
          )}
          <p className="text-[12.5px] text-fg-subtle">Le compte n&apos;est pas supprimé : vous pourrez rétablir l&apos;accès à tout moment.</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRevoke(null)}>Annuler</Button>
            <Button variant="danger" loading={pending} onClick={() => revoke && setStatus(revoke, "disabled")}>
              <UserX /> Retirer l&apos;accès
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
