"use client";
// Super admin : accès au tableau de bord d'un client (propriétaires, administrateurs, dispatchers). Fiche du client
// (docs/REFONTE-PANELS.md, R4) : « Donner un accès » ouvre sur l'invitation par e-mail ; le mot de passe provisoire
// (serveur sans e-mail) est derrière une case. Retirer un accès ou annuler une invitation : confirmation. Actions
// serveur et charge envoyée inchangées.
import { ORG_ROLE_LABELS, formatDate, type OrgRole } from "@rydar/shared";
import { KeyRound, LockOpen, Mail, UserPlus, UserX, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { grantOrganizationAccess, resendOrganizationInvitation, setOrganizationMemberStatus, unlockMemberLogin } from "@/app/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

export type AccessMember = {
  id: string;
  role: OrgRole;
  status: "active" | "invited" | "disabled";
  created_at: string;
  user: { full_name: string | null; email: string } | null;
  /** Compte Auth verrouillé (connexion impossible partout) */
  loginLocked?: boolean;
  /** Fiche chauffeur du compte bannie (par le client qui l'emploie ou de la plateforme) : le verrou ne se lève pas d'ici */
  driverBan?: "org" | "platform" | null;
};

const DRIVER_BAN_TEXT = {
  org: "Fiche chauffeur bannie par le client qui l'emploie\u00a0: lui seul peut lever le bannissement.",
  platform: "Banni de la plateforme (signalement de fraude)\u00a0: levée depuis «\u00a0Signalements de fraude\u00a0».",
} as const;

const ROLE_HELP: Record<OrgRole, string> = {
  owner: "Tout, y compris facturation et équipe",
  admin: "Réglages, chauffeurs, validations, bannissements",
  dispatcher: "Courses, carte, messages (consultation du réseau)",
};
const ROLE_TONE: Record<OrgRole, "brand" | "blue" | "neutral"> = { owner: "brand", admin: "blue", dispatcher: "neutral" };

const nameOf = (m: AccessMember) => m.user?.full_name ?? m.user?.email ?? "—";

export function OrganizationAccessCard({ orgId, orgName, members }: { orgId: string; orgName: string; members: AccessMember[] }) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<OrgRole>("dispatcher");
  // Invitation par e-mail par défaut ; mot de passe provisoire seulement si la case est cochée (serveur sans e-mail)
  const [temporary, setTemporary] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revoke, setRevoke] = useState<AccessMember | null>(null);
  const [cancelInvite, setCancelInvite] = useState<AccessMember | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const activeOwners = members.filter((m) => m.role === "owner" && m.status === "active").length;
  const sorted = [...members].sort(
    (a, b) =>
      Number(a.status !== "active") - Number(b.status !== "active") ||
      ["owner", "admin", "dispatcher"].indexOf(a.role) - ["owner", "admin", "dispatcher"].indexOf(b.role) ||
      (a.user?.full_name ?? "").localeCompare(b.user?.full_name ?? ""),
  );

  const openGrant = () => {
    setErrors({});
    setTemporary(false);
    setOpen(true);
  };

  const setStatus = (m: AccessMember, status: "active" | "disabled") => {
    setBusy(m.id);
    start(() => runAction(async () => {
      const res = await setOrganizationMemberStatus(orgId, m.id, status);
      setBusy(null);
      if (!res.ok) return void toast.error(res.error);
      if (m.status === "invited") toast.success(`Invitation annulée\u00a0: ${m.user?.email ?? m.user?.full_name}`);
      else {
        toast.success(status === "disabled" ? `Accès retiré\u00a0: ${nameOf(m)}` : `Accès rétabli\u00a0: ${nameOf(m)}`, {
          description: status === "disabled" ? "Sessions fermées, sauf s'il garde un autre accès (autre client, application chauffeur)." : undefined,
        });
      }
      setRevoke(null);
      setCancelInvite(null);
      router.refresh();
    }));
  };

  const resend = (m: AccessMember) => {
    setBusy(m.id);
    start(() => runAction(async () => {
      const res = await resendOrganizationInvitation(orgId, m.id);
      setBusy(null);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Invitation renvoyée\u00a0: ${m.user?.email ?? m.user?.full_name}`);
    }));
  };

  // Ancien bannissement hérité (suspension de client, fiche chauffeur désactivée avant le correctif) : levée du verrou
  const unlock = (m: AccessMember) => {
    setBusy(m.id);
    start(() => runAction(async () => {
      const res = await unlockMemberLogin(orgId, m.id);
      setBusy(null);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message);
      router.refresh();
    }));
  };

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardHeader
        title="Accès"
        icon={<KeyRound />}
        description={"Tableau de bord du client\u00a0: propriétaire, administrateurs, dispatchers."}
        action={
          <Button variant="secondary" size="sm" onClick={openGrant}>
            <UserPlus /> Donner un accès
          </Button>
        }
      />
      <ul className="divide-y divide-line">
        {sorted.map((m) => {
          const name = nameOf(m);
          const invited = m.status === "invited";
          const disabled = m.status === "disabled";
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
              <Avatar name={name} size={32} />
              <div className="min-w-0 flex-1 basis-[min(100%,12rem)]">
                <p className={cn("truncate text-[13.5px] font-medium", m.status === "active" ? "text-fg" : "text-fg-muted")}>{name}</p>
                <p className="truncate text-[12px] text-fg-muted" title={`${invited ? "Invitation du" : "Accès depuis le"} ${formatDate(m.created_at)}`}>
                  {m.user?.email}
                </p>
                {m.loginLocked && (
                  <p className="mt-1 text-[12px] leading-snug text-fg-muted">
                    {m.driverBan
                      ? DRIVER_BAN_TEXT[m.driverBan]
                      : "Connexion bloquée sans bannissement en cours (ancien blocage\u00a0: suspension de client, fiche chauffeur désactivée)."}
                  </p>
                )}
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 pl-[44px] sm:w-auto sm:pl-0">
                <Badge tone={ROLE_TONE[m.role]} dot={false}>{ORG_ROLE_LABELS[m.role]}</Badge>
                {disabled && <Badge tone="red">Accès retiré</Badge>}
                {m.loginLocked && <Badge tone="red">Connexion bloquée</Badge>}
                {m.loginLocked && !m.driverBan && (
                  <Button variant="ghost" size="xs" loading={pending && busy === m.id} disabled={pending} onClick={() => unlock(m)}>
                    <LockOpen /> Débloquer la connexion
                  </Button>
                )}
                {invited ? (
                  <>
                    <Badge tone="amber">Invitation envoyée</Badge>
                    <Button variant="ghost" size="xs" loading={pending && busy === m.id} onClick={() => resend(m)}>
                      <Mail /> Renvoyer l&apos;invitation
                    </Button>
                    <Button variant="ghost" size="xs" className="hover:text-red" disabled={pending} onClick={() => setCancelInvite(m)}>
                      <UserX /> Annuler l&apos;invitation
                    </Button>
                  </>
                ) : disabled ? (
                  <Button variant="ghost" size="xs" loading={pending && busy === m.id} onClick={() => setStatus(m, "active")}>
                    <Undo2 /> Rétablir l&apos;accès
                  </Button>
                ) : (
                  <Button variant="ghost" size="xs" className="hover:text-red" onClick={() => setRevoke(m)}>
                    <UserX /> Retirer l&apos;accès
                  </Button>
                )}
              </div>
            </li>
          );
        })}
        {!members.length && <li className="px-5 py-6 text-[13px] text-fg-muted">Aucun compte{"\u00a0"}: donnez un premier accès.</li>}
      </ul>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent
          title="Donner un accès"
          description={`Accès au tableau de bord de ${orgName}. La personne reçoit un e-mail pour choisir son mot de passe\u00a0; une adresse déjà liée à un compte reçoit un lien pour activer elle-même son accès.`}
        >
          <form
            onSubmit={submitWith((f) =>
              start(() => runAction(async () => {
                const res = await grantOrganizationAccess(orgId, {
                  fullName: String(f.get("fullName") ?? ""),
                  email: String(f.get("email") ?? ""),
                  role,
                  // undefined = invitation par e-mail ; chaîne (même vide) = mot de passe provisoire
                  password: temporary ? String(f.get("password") ?? "") : undefined,
                });
                if (!res.ok) {
                  setErrors(res.fieldErrors ?? {});
                  return void toast.error(res.error);
                }
                if (res.pending) {
                  toast.success("Invitation envoyée", {
                    description: [
                      "Cette adresse a déjà un compte\u00a0: l'accès sera actif quand la personne aura choisi son mot de passe avec le lien reçu par e-mail.",
                      res.passwordIgnored ? "Le mot de passe provisoire n'est pas appliqué." : "",
                      res.emailSent ? "" : "L'e-mail n'a pas pu partir\u00a0: utilisez «\u00a0Renvoyer l'invitation\u00a0» dans une minute.",
                    ].filter(Boolean).join(" "),
                    duration: 12000,
                  });
                } else {
                  toast.success(`Accès ${ORG_ROLE_LABELS[role].toLowerCase()} donné`, {
                    description: res.invited
                      ? "Invitation envoyée par e-mail."
                      : res.created
                        ? "Compte créé\u00a0: transmettez l'e-mail et le mot de passe provisoire."
                        : res.reactivated
                          ? "Accès rétabli sur le compte existant."
                          : "Accès ajouté à votre propre compte.",
                  });
                }
                setOpen(false);
                router.refresh();
              })),
            )}
            className="space-y-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nom complet" error={errors.fullName}>
                <Input name="fullName" required autoComplete="off" />
              </Field>
              <Field label="E-mail" error={errors.email}>
                <Input name="email" type="email" inputMode="email" required autoComplete="off" />
              </Field>
            </div>
            <div>
              <p id={`${uid}-role`} className="mb-1.5 text-[12.5px] font-medium text-fg-muted">
                Rôle
              </p>
              <div role="radiogroup" aria-labelledby={`${uid}-role`} className="grid gap-2 sm:grid-cols-3">
                {(["owner", "admin", "dispatcher"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={role === r}
                    onClick={() => setRole(r)}
                    className={cn("flex flex-col justify-start rounded-xl border p-3 text-left", role === r ? "border-brand/50 bg-brand/[0.06]" : "border-line hover:border-line-strong")}
                  >
                    <span className={cn("block text-[13px] font-medium", role === r ? "text-brand" : "text-fg")}>{ORG_ROLE_LABELS[r]}</span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-fg-muted">{ROLE_HELP[r]}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <label htmlFor={`${uid}-temporary`} className="flex cursor-pointer items-start gap-2.5">
                <input
                  id={`${uid}-temporary`}
                  type="checkbox"
                  checked={temporary}
                  onChange={(e) => setTemporary(e.target.checked)}
                  disabled={pending}
                  className="mt-1 size-4 shrink-0 accent-brand"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-fg">Mot de passe provisoire (serveur sans e-mail)</span>
                  <span className="block text-[12.5px] leading-[18px] text-fg-muted">
                    À n&apos;utiliser que si l&apos;envoi des e-mails n&apos;est pas configuré{"\u00a0"}: transmettez-le à la personne, qui le changera.
                  </span>
                </span>
              </label>
              {temporary && (
                <Field
                  label="Mot de passe provisoire"
                  error={errors.password}
                  hint="10 caractères au moins. Non appliqué si un compte existe déjà avec cet e-mail (la personne reçoit un lien)."
                >
                  <Input name="password" type="text" minLength={10} required autoComplete="new-password" className="num" />
                </Field>
              )}
            </div>
            <DialogFooter backDisabled={pending}>
              <Button type="submit" variant="primary" loading={pending}>
                {temporary ? "Donner l'accès" : "Inviter par e-mail"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revoke} onOpenChange={(o) => !o && !pending && setRevoke(null)}>
        <DialogContent
          title="Retirer l'accès ?"
          description={
            revoke
              ? `${nameOf(revoke)} (${ORG_ROLE_LABELS[revoke.role]}) ne pourra plus ouvrir le tableau de bord de ${orgName}\u00a0; ses sessions sont fermées, sauf s'il garde un autre accès (autre client, application chauffeur).`
              : undefined
          }
        >
          {revoke?.role === "owner" && activeOwners <= 1 && (
            <Callout tone="warning" className="mb-4 text-[13px]">
              C&apos;est le dernier propriétaire actif{"\u00a0"}: donnez d&apos;abord un accès propriétaire à quelqu&apos;un d&apos;autre si le compte doit rester géré.
            </Callout>
          )}
          <p className="text-[13px] text-fg-muted">Le compte n&apos;est pas supprimé{"\u00a0"}: vous pourrez rétablir l&apos;accès à tout moment.</p>
          <DialogFooter backDisabled={pending}>
            <Button variant="danger" loading={pending} onClick={() => revoke && setStatus(revoke, "disabled")}>
              <UserX /> Retirer l&apos;accès
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!cancelInvite}
        onOpenChange={(o) => !o && !pending && setCancelInvite(null)}
        title="Annuler l'invitation ?"
        consequence={
          cancelInvite
            ? `L'invitation de ${nameOf(cancelInvite)} (${ORG_ROLE_LABELS[cancelInvite.role]}) est supprimée\u00a0: le lien reçu par e-mail ne donnera plus accès au tableau de bord de ${orgName}. Vous pourrez l'inviter de nouveau.`
            : ""
        }
        confirmLabel="Annuler l'invitation"
        loading={pending}
        onConfirm={() => cancelInvite && setStatus(cancelInvite, "disabled")}
      />
    </Card>
  );
}
