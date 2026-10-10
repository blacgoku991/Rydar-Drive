"use client";
// Réglages › Équipe (docs/REFONTE-PANELS.md § 5.6, lot R10) : rôles expliqués, ajout d'un membre en une fenêtre simple
// (invitation par e-mail par défaut, mot de passe provisoire sur option), et plus aucune coupure d'accès en un clic :
// changer un rôle, retirer un accès ou annuler une invitation passent par une confirmation qui dit la conséquence.
// Actions inchangées (inviteMember, updateMember, resendMemberInvitation, cancelMemberInvitation) ; seul le
// propriétaire change un rôle ou retire un accès (contrôlé par updateMember).
import { EllipsisVertical, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelMemberInvitation, inviteMember, resendMemberInvitation, updateMember } from "@/app/dashboard/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Avatar, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

const NB = " ";

export type TeamMember = {
  id: string;
  user_id: string;
  role: "owner" | "admin" | "dispatcher";
  status: "active" | "disabled" | "invited";
  created_at: string;
  user: { full_name: string | null; email: string } | null;
};

const ROLE_LABEL: Record<TeamMember["role"], string> = { owner: "Propriétaire", admin: "Administrateur", dispatcher: "Dispatcher" };
/** Ce que permet chaque rôle (contrôles des actions : isAdminRole ; propriétaire seul pour l'abonnement, les rôles et le retrait d'un accès). */
const ROLE_HELP: Record<"admin" | "dispatcher", string> = {
  admin: `Tout, sauf l'abonnement, les rôles et le retrait d'un accès (réservés au propriétaire).`,
  dispatcher: `Courses, chauffeurs et carte en direct${NB}; réglages en lecture seule.`,
};

type Confirm = { kind: "role" | "disable" | "cancel"; member: TeamMember };

export function TeamPanel({ members, isOwner, canInvite }: { members: TeamMember[]; isOwner: boolean; canInvite: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, startAdding] = useTransition();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"admin" | "dispatcher">("dispatcher");
  const [withPassword, setWithPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const roleId = useId();

  const nameOf = (m: TeamMember) => m.user?.full_name || m.user?.email || "ce membre";

  /** Action d'un membre : toast, fenêtre fermée et page relue en cas de succès ; fenêtre gardée en cas d'échec. */
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) =>
    start(() =>
      runAction(async () => {
        const res = await fn();
        if (!res.ok) return void toast.error(res.error ?? "Action impossible.");
        toast.success(msg);
        setConfirm(null);
        router.refresh();
      }),
    );

  const openAdd = () => {
    setRole("dispatcher");
    setWithPassword(false);
    setErrors({});
    setOpen(true);
  };

  const confirmAction = () => {
    if (!confirm) return;
    const { kind, member: m } = confirm;
    if (kind === "role") {
      const next = m.role === "admin" ? "dispatcher" : "admin";
      run(() => updateMember(m.id, { role: next }), next === "admin" ? "Rôle changé : administrateur" : "Rôle changé : dispatcher");
    } else if (kind === "disable") run(() => updateMember(m.id, { status: "disabled" }), "Accès retiré");
    else run(() => cancelMemberInvitation(m.id), "Invitation annulée");
  };

  /** Actions possibles sur un membre (même liste en boutons sur grand écran et dans le menu ⋮ sur téléphone). */
  const actionsOf = (m: TeamMember) => {
    const list: { key: string; label: string; danger?: boolean; onSelect: () => void }[] = [];
    if (m.status === "invited") {
      if (!canInvite) return list;
      list.push({ key: "resend", label: "Renvoyer l'invitation", onSelect: () => run(() => resendMemberInvitation(m.id), "Invitation renvoyée") });
      // Invitation d'un propriétaire : seul un propriétaire l'annule (ou le super admin)
      if (m.role !== "owner" || isOwner) list.push({ key: "cancel", label: "Annuler l'invitation", danger: true, onSelect: () => setConfirm({ kind: "cancel", member: m }) });
      return list;
    }
    if (!isOwner || m.role === "owner") return list;
    list.push({
      key: "role",
      label: m.role === "admin" ? "Passer dispatcher" : "Passer administrateur",
      onSelect: () => setConfirm({ kind: "role", member: m }),
    });
    if (m.status === "active") list.push({ key: "disable", label: "Retirer l'accès", danger: true, onSelect: () => setConfirm({ kind: "disable", member: m }) });
    else list.push({ key: "enable", label: "Rétablir l'accès", onSelect: () => run(() => updateMember(m.id, { status: "active" }), "Accès rétabli") });
    return list;
  };

  const c = confirm;
  const cName = c ? nameOf(c.member) : "";
  const toAdmin = c?.kind === "role" && c.member.role !== "admin";

  return (
    <Card className="max-w-4xl">
      <CardHeader
        title="Équipe"
        description="Les personnes qui gèrent cet espace avec vous."
        action={
          canInvite ? (
            <Button variant="primary" size="sm" onClick={openAdd} className="max-sm:min-h-11">
              <UserPlus aria-hidden /> Ajouter un membre
            </Button>
          ) : undefined
        }
      />
      <dl className="grid gap-x-6 gap-y-1.5 border-b border-line px-5 py-3 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="font-medium text-fg">Administrateur</dt>
        <dd className="text-fg-muted">{ROLE_HELP.admin}</dd>
        <dt className="font-medium text-fg">Dispatcher</dt>
        <dd className="text-fg-muted">{ROLE_HELP.dispatcher}</dd>
      </dl>
      {canInvite && !isOwner && (
        <div className="border-b border-line px-5 py-3">
          <Callout tone="neutral" role={null}>
            Seul le propriétaire peut changer un rôle ou retirer un accès.
          </Callout>
        </div>
      )}
      <ul className="divide-y divide-line">
        {members.map((m) => {
          const invited = m.status === "invited";
          const actions = actionsOf(m);
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <Avatar name={m.user?.full_name ?? m.user?.email ?? "?"} size={34} />
              <div className="min-w-0 flex-1 basis-[12rem]">
                <p className="text-[14px] font-medium text-fg [overflow-wrap:anywhere]">{invited ? m.user?.email : (m.user?.full_name ?? "—")}</p>
                <p className="text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">
                  {invited ? `Accès actif dès que la personne aura choisi son mot de passe avec le lien reçu.` : m.user?.email}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={m.role === "owner" ? "brand" : m.role === "admin" ? "blue" : "neutral"}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
                {invited ? <Badge tone="amber">Invitation envoyée</Badge> : m.status !== "active" && <Badge tone="red">Accès retiré</Badge>}
              </div>
              {actions.length > 0 && (
                <>
                  {/* Grand écran : boutons visibles ; téléphone : menu ⋮ (un seul des deux rendus est affiché) */}
                  <div className="hidden flex-wrap gap-1 sm:flex">
                    {actions.map((a) => (
                      <Button key={a.key} variant="ghost" size="sm" disabled={pending} className={cn(a.danger && "text-red hover:text-red")} onClick={a.onSelect}>
                        {a.label}
                      </Button>
                    ))}
                  </div>
                  <div className="sm:hidden">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" disabled={pending} aria-label={`Actions pour ${nameOf(m)}`} className="size-11">
                          <EllipsisVertical aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))]">
                        {actions.map((a, i) => (
                          <div key={a.key}>
                            {a.danger && i > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuItem destructive={a.danger} className="min-h-11" onSelect={a.onSelect}>
                              {a.label}
                            </DropdownMenuItem>
                          </div>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {/* Changer un rôle, retirer un accès, annuler une invitation : conséquence dite avant d'agir (updateMember,
          cancelMemberInvitation ; un accès retiré se rétablit) */}
      <ConfirmDialog
        open={!!c}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title={
          !c
            ? ""
            : c.kind === "role"
              ? `Passer ${cName} ${toAdmin ? "administrateur" : "dispatcher"}${NB}?`
              : c.kind === "disable"
                ? `Retirer l'accès de ${cName}${NB}?`
                : `Annuler l'invitation de ${cName}${NB}?`
        }
        consequence={
          !c
            ? ""
            : c.kind === "role"
              ? toAdmin
                ? `Cette personne pourra modifier les réglages, les tarifs et les clés de connexion, et ajouter des membres. L'abonnement, les rôles et le retrait d'un accès restent réservés au propriétaire.`
                : `Cette personne gardera les courses, les chauffeurs et la carte, mais ne pourra plus modifier les réglages ni gérer les clés de connexion.`
              : c.kind === "disable"
                ? `Cette personne ne pourra plus ouvrir cet espace${NB}; vous pourrez rétablir son accès.`
                : `Le lien envoyé ne donnera plus accès à cet espace${NB}; vous pourrez inviter de nouveau cette adresse.`
        }
        confirmLabel={!c ? "" : c.kind === "role" ? (toAdmin ? "Passer administrateur" : "Passer dispatcher") : c.kind === "disable" ? "Retirer l'accès" : "Annuler l'invitation"}
        tone={c?.kind === "role" ? "primary" : "danger"}
        loading={pending}
        onConfirm={confirmAction}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Ajouter un membre" description="La personne reçoit un e-mail pour choisir son mot de passe.">
          <form
            noValidate
            onSubmit={submitWith((f) =>
              startAdding(() =>
                runAction(async () => {
                  const res = await inviteMember({
                    fullName: String(f.get("name") ?? ""),
                    email: String(f.get("email") ?? ""),
                    role,
                    password: withPassword ? String(f.get("password") ?? "") : "",
                  });
                  if (!res.ok) {
                    setErrors(res.fieldErrors ?? {});
                    return void toast.error(res.error);
                  }
                  setErrors({});
                  setOpen(false);
                  if (res.existingAccount) {
                    toast.success("Invitation envoyée", {
                      description: [
                        "Cette adresse a déjà un compte Rydar Drive : l'accès sera actif quand la personne aura choisi son mot de passe avec le lien reçu par e-mail.",
                        res.passwordIgnored ? "Le mot de passe provisoire n'est pas appliqué." : "",
                        res.emailSent ? "" : "L'e-mail n'a pas pu partir : utilisez « Renvoyer l'invitation » dans une minute.",
                      ]
                        .filter(Boolean)
                        .join(" "),
                      duration: 12000,
                    });
                  } else toast.success(res.invited ? "Invitation envoyée par e-mail" : "Membre ajouté");
                  router.refresh();
                }),
              ),
            )}
            className="space-y-4"
          >
            <Field label="Nom complet" error={errors.fullName}>
              <Input name="name" required autoComplete="name" maxLength={120} placeholder="ex. : Sarah Martin" />
            </Field>
            <Field label="E-mail" error={errors.email}>
              <Input name="email" type="email" inputMode="email" required autoComplete="email" maxLength={254} placeholder="ex. : sarah@monsite.fr" />
            </Field>
            <fieldset>
              <legend id={roleId} className="mb-2 text-[12.5px] font-medium text-fg-muted">
                Rôle
              </legend>
              <div role="radiogroup" aria-labelledby={roleId} className="grid gap-2 sm:grid-cols-2">
                {(["dispatcher", "admin"] as const).map((r) => (
                  <label
                    key={r}
                    className={cn(
                      "flex cursor-pointer gap-2.5 rounded-xl border p-3 text-[13px] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40",
                      role === r ? "border-brand/50 bg-brand/[0.06]" : "border-line hover:border-line-strong",
                    )}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      checked={role === r}
                      onChange={() => setRole(r)}
                      aria-labelledby={`${roleId}-${r}`}
                      aria-describedby={`${roleId}-${r}-hint`}
                      className="mt-0.5 accent-brand"
                    />
                    <span>
                      <span id={`${roleId}-${r}`} className="block font-medium text-fg">
                        {ROLE_LABEL[r]}
                      </span>
                      <span id={`${roleId}-${r}-hint`} className="mt-0.5 block text-[12.5px] text-fg-muted">
                        {ROLE_HELP[r]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {errors.role && <p className="mt-1.5 text-xs text-red">{errors.role}</p>}
            </fieldset>
            {/* Nom de la case : l'option seule ; l'explication en description (lecteurs d'écran) */}
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-fg">
              <input
                type="checkbox"
                checked={withPassword}
                onChange={(e) => setWithPassword(e.target.checked)}
                aria-labelledby={`${roleId}-pw`}
                aria-describedby={`${roleId}-pw-hint`}
                className="mt-0.5 size-4 accent-brand"
              />
              <span>
                <span id={`${roleId}-pw`}>Option{NB}: définir un mot de passe provisoire</span>
                <span id={`${roleId}-pw-hint`} className="block text-[12.5px] text-fg-muted">
                  Au lieu de l&apos;e-mail{NB}: vous transmettez vous-même le mot de passe à la personne.
                </span>
              </span>
            </label>
            {withPassword && (
              <Field
                label="Mot de passe provisoire"
                hint="10 caractères au moins. Sans effet si l'adresse a déjà un compte Rydar Drive : elle reçoit alors un lien."
                error={errors.password}
              >
                <Input name="password" type="text" autoComplete="new-password" minLength={10} maxLength={72} className="num" />
              </Field>
            )}
            <DialogFooter backDisabled={adding}>
              <Button type="submit" variant="primary" loading={adding}>
                Ajouter le membre
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
