"use client";
import { DISPATCH_MODEL_META, formatNumber, slugify, type DispatchModel } from "@rydar/shared";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { createOrganization, savePlan, setOrganizationStatus, updateOrganizationPlan } from "@/app/admin/actions";
import { FeeFields, feeRule } from "@/components/admin/dispatch-model";
import { readFees } from "@/components/admin/fees";
import { PLAN_NUMBER_LIMITS, PLAN_OPTION_LIMITS, planSummary } from "@/components/admin/org-watch";
import { NO_PLAN_LIMITS, effectiveLimits, limitEnabled } from "@/components/admin/private-fleet-state";
import { frSpaces } from "@/components/platform-fees/org-platform-format";
import { Columns, DataTable } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, SheetContent } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { FormSection } from "@/components/ui/form-section";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import type { SuspensionBasis } from "@/lib/suspension";
import { cn, submitWith } from "@/lib/utils";
import { plural } from "@/lib/wording";

const dayLabel = (v: string) => {
  const d = new Date(v);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function PlatformDailyChart({ data }: { data: { date: string; rides: number; completed: number }[] }) {
  return (
    <>
      <Columns data={data} x="date" y="rides" name="Courses" labelFormat={dayLabel} height={220} />
      <DataTable rows={data} columns={[{ key: "date", label: "Jour", format: dayLabel }, { key: "rides", label: "Courses" }, { key: "completed", label: "Terminées" }]} />
    </>
  );
}

/** Types d'une organisation standard (Flotte Privée : CreatePrivateFleetSheet), dans l'ordre de « Nouveau client ». */
const ORG_MODELS: DispatchModel[] = ["fleet", "centrale"];

/**
 * Nouveau client Flotte ou Centrale à commission (docs/REFONTE-PANELS.md, R3) : ouvert par « Nouveau client »
 * (components/admin/new-client.tsx) avec le type choisi (`initialModel`, modifiable ici). Champs, charge envoyée à
 * createOrganization, fieldErrors et frais appliqués dès la création : inchangés. Sans mot de passe provisoire (case
 * décochée : champ absent, donc vide), le propriétaire est invité par e-mail.
 */
export function CreateOrganizationSheet({
  plans,
  rootDomain,
  initialModel = "fleet",
  open,
  onOpenChange,
}: {
  plans: { code: string; name: string }[];
  /** NEXT_PUBLIC_ROOT_DOMAIN : adresse du client (identifiant.domaine) */
  rootDomain: string;
  /** Type choisi dans « Nouveau client » */
  initialModel?: DispatchModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [model, setModel] = useState<DispatchModel>(initialModel);
  const [feePercent, setFeePercent] = useState("0");
  const [feeFixed, setFeeFixed] = useState("0");
  const [feeErrors, setFeeErrors] = useState<{ percent?: string; fixed?: string }>({});
  const [temporary, setTemporary] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <SheetContent title="Nouveau client" description={"Chaque client a son espace séparé\u00a0: ses chauffeurs, ses courses, son API et son mini-site."}>
        <form
          onSubmit={submitWith((f) =>
            start(() => runAction(async () => {
              const g = (k: string) => String(f.get(k) ?? "");
              // Frais Rydar par course : flotte comme centrale (20260924006400)
              const fees = readFees(feePercent, feeFixed);
              if (!fees.valid) return void setFeeErrors(fees.errors);
              setFeeErrors({});
              setErrors({});
              const res = await createOrganization(
                {
                  name, slug, planCode: g("plan"), email: g("email"), phone: g("phone"), city: g("city"),
                  ownerName: g("ownerName"), ownerEmail: g("ownerEmail"), ownerPassword: g("ownerPassword"),
                },
                { dispatchModel: model, platformFeePercent: fees.percent, platformFeeFixedCents: fees.fixedCents },
              );
              if (!res.ok) {
                setErrors(res.fieldErrors ?? {});
                if (res.fieldErrors?.platformFeePercent || res.fieldErrors?.platformFeeFixedCents) {
                  setFeeErrors({ percent: res.fieldErrors.platformFeePercent, fixed: res.fieldErrors.platformFeeFixedCents });
                }
                return void toast.error(res.error);
              }
              if (res.ownerInvited) {
                toast.success("Client créé", {
                  description: frSpaces(
                    [
                      "Cette adresse a déjà un compte Rydar Drive : le propriétaire activera son accès en choisissant son mot de passe avec le lien reçu par e-mail.",
                      res.passwordIgnored ? "Le mot de passe provisoire n'est pas appliqué." : "",
                      res.emailSent ? "" : "L'e-mail n'a pas pu partir : renvoyez l'invitation depuis la fiche du client (Accès).",
                    ].filter(Boolean).join(" "),
                  ),
                  duration: 12000,
                });
              } else toast.success("Client créé");
              onOpenChange(false);
              router.push(`/admin/organizations/${res.id}`);
            })),
          )}
          className="space-y-7 px-6 py-6"
        >
          <FormSection step={1} title="Client">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom commercial" className="sm:col-span-2" error={errors.name}>
                <Input
                  value={name}
                  required
                  onChange={(e) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); }}
                  placeholder={"ex.\u00a0: Élite Chauffeurs Paris"}
                  autoComplete="off"
                />
              </Field>
              <Field label="Identifiant" hint={`Adresse\u00a0: ${slug || "identifiant"}.${rootDomain}`} error={errors.slug}>
                <Input value={slug} required onChange={(e) => { setTouched(true); setSlug(slugify(e.target.value)); }} className="num" autoComplete="off" />
              </Field>
              <Field label="Offre" optional hint={"Sans offre\u00a0: aucune limite"} error={errors.planCode}>
                <NativeSelect name="plan" defaultValue="">
                  <option value="">Sans offre</option>
                  {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                </NativeSelect>
              </Field>
              <Field label="E-mail de contact" error={errors.email} hint="Adresse de l'entreprise (factures, annonces des frais).">
                <Input name="email" type="email" required autoComplete="off" />
              </Field>
              <Field label="Téléphone" optional error={errors.phone}>
                <Input name="phone" type="tel" autoComplete="off" />
              </Field>
              <Field label="Ville" optional className="sm:col-span-2" error={errors.city}>
                <Input name="city" autoComplete="off" />
              </Field>
            </div>
          </FormSection>

          <FormSection step={2} title="Type et frais Rydar">
            <fieldset className="min-w-0 space-y-2">
              <legend className="mb-1.5 text-[12.5px] font-medium text-fg-muted">Type de client</legend>
              <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-ink-850 p-1">
                {ORG_MODELS.map((m) => (
                  <label
                    key={m}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center justify-center rounded-lg px-2 text-center text-[13px] font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/50",
                      model === m ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg",
                      pending && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${uid}-model`}
                      value={m}
                      checked={model === m}
                      onChange={() => setModel(m)}
                      disabled={pending}
                      className="sr-only"
                    />
                    {DISPATCH_MODEL_META[m].label}
                  </label>
                ))}
              </div>
              <p className="text-[13px] leading-relaxed text-fg-muted">{frSpaces(DISPATCH_MODEL_META[model].description)}</p>
            </fieldset>
            <div className="space-y-3 rounded-xl border border-line bg-white/[0.02] p-4">
              <p className="text-[13px] leading-relaxed text-fg-muted">
                Frais dus à Rydar pour chaque course terminée, en plus de l&apos;abonnement (0{"\u00a0"}: aucun frais).
              </p>
              <FeeFields model={model} percent={feePercent} fixed={feeFixed} onPercent={setFeePercent} onFixed={setFeeFixed} errors={feeErrors} disabled={pending} />
              <Disclosure title="En savoir plus" summaryClassName="text-[13px]" contentClassName="space-y-2 pb-1 text-[12.5px] leading-relaxed text-fg-muted">
                <p>{frSpaces(feeRule(model))}</p>
                <p>
                  Appliqués dès la création. Ensuite, une hausse est annoncée au moins 30{"\u00a0"}jours à l&apos;avance (ou appliquée sur accord
                  écrit du client), depuis la fiche du client.
                </p>
              </Disclosure>
            </div>
          </FormSection>

          <FormSection step={3} title="Compte du propriétaire" description="Par défaut, le propriétaire reçoit un e-mail pour choisir son mot de passe.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom complet" error={errors.ownerName}>
                <Input name="ownerName" required autoComplete="off" />
              </Field>
              <Field label="E-mail" error={errors.ownerEmail}>
                <Input name="ownerEmail" type="email" required autoComplete="off" />
              </Field>
            </div>
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
                <span className="block text-[13px] font-medium text-fg">Définir un mot de passe provisoire (serveur sans e-mail)</span>
                <span className="block text-[12.5px] leading-[18px] text-fg-muted">
                  À n&apos;utiliser que si l&apos;envoi des e-mails n&apos;est pas configuré{"\u00a0"}: transmettez-le au propriétaire, qui le changera dès sa
                  première connexion.
                </span>
              </span>
            </label>
            {temporary && (
              <Field label="Mot de passe provisoire" error={errors.ownerPassword} hint="10 caractères au moins.">
                <Input name="ownerPassword" type="text" required minLength={10} maxLength={72} className="num" autoComplete="new-password" />
              </Field>
            )}
          </FormSection>

          <DialogFooter sticky backDisabled={pending}>
            <Button type="submit" variant="primary" loading={pending}>
              {temporary ? "Créer le client" : "Créer et inviter"}
            </Button>
          </DialogFooter>
        </form>
      </SheetContent>
    </Dialog>
  );
}

/** Fondements d'une suspension (CGV, article 7). */
const SUSPENSION_BASES = [
  { value: "notice", label: "Mise en demeure restée sans effet (8 jours au moins)" },
  { value: "urgent", label: "Urgence : fraude, usage illicite ou atteinte à la sécurité du service" },
  { value: "request", label: "Demande écrite du client" },
] as const;

/**
 * Statut d'un client (fiche du super admin, docs/REFONTE-PANELS.md R4) : « Réactiver » dans l'en-tête (`part` =
 * « reactivate », client suspendu ou archivé), « Suspendre » et « Archiver » en bas de la fiche (`part` = « sensitive » :
 * zone sensible, rien pour un client archivé). Mêmes dialogues, mêmes champs, même action serveur.
 */
export function OrganizationStatusActions({ orgId, status, part }: { orgId: string; status: string; part: "reactivate" | "sensitive" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [reason, setReason] = useState("");
  const [basis, setBasis] = useState<"" | SuspensionBasis["kind"]>("");
  const [noticeDate, setNoticeDate] = useState("");
  const run = (s: "active" | "suspended" | "archived") =>
    start(() => runAction(async () => {
      const res = await setOrganizationStatus(orgId, s, reason, basis ? { kind: basis, noticeDate: noticeDate || null } : undefined);
      if (!res.ok) return void toast.error(res.error);
      toast.success(s === "active" ? "Client réactivé" : s === "suspended" ? "Client suspendu\u00a0: accès coupés" : "Client archivé");
      setOpen(false);
      setArchiving(false);
      router.refresh();
    }));

  if (part === "reactivate") {
    return status !== "active" ? (
      <Button variant="primary" loading={pending} onClick={() => run("active")}>
        Réactiver
      </Button>
    ) : null;
  }
  if (status === "archived") return null;
  return (
    <section aria-labelledby={`zone-sensible-${orgId}`} className="rounded-xl border border-red/25">
      <div className="border-b border-line px-5 py-4">
        <h2 id={`zone-sensible-${orgId}`} className="text-[14px] font-semibold tracking-tight text-fg">
          Zone sensible
        </h2>
        <p className="mt-0.5 text-[12.5px] text-fg-muted">Ces actions coupent l&apos;accès du client à son espace et à ses chauffeurs.</p>
      </div>
      <ul className="divide-y divide-line">
        {status === "active" && (
          <SensitiveRow
            title="Suspendre le client"
            consequence="Membres et chauffeurs perdent immédiatement l'accès aux données ; les courses ne sont plus dispatchées. Fondement et motif obligatoires (CGV, article 7)."
          >
            <Button variant="danger" onClick={() => setOpen(true)}>
              Suspendre
            </Button>
          </SensitiveRow>
        )}
        <SensitiveRow
          title="Archiver le client"
          consequence="Membres et chauffeurs perdent l'accès, les courses ne sont plus dispatchées ; données et registre des frais conservés, réactivation possible."
        >
          <Button variant="danger" onClick={() => setArchiving(true)}>
            Archiver
          </Button>
        </SensitiveRow>
      </ul>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Suspendre ce client ?"
          description="Membres et chauffeurs perdent immédiatement l'accès aux données ; les courses ne sont plus dispatchées. Le propriétaire et les administrateurs peuvent encore se connecter pour voir la suspension et régler les frais dus."
        >
          <div className="space-y-4">
            <Field label="Fondement" hint="Article 7 des CGV. Le fondement et le motif sont enregistrés et affichés au propriétaire et aux administrateurs du client.">
              <NativeSelect value={basis} onChange={(e) => setBasis(e.target.value as "" | SuspensionBasis["kind"])}>
                <option value="">Choisir…</option>
                {SUSPENSION_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </NativeSelect>
            </Field>
            {basis === "notice" && (
              <Field label="Date de la mise en demeure" hint="Envoyée par écrit au propriétaire, il y a 8 jours au moins.">
                <Input type="date" value={noticeDate} onChange={(e) => setNoticeDate(e.target.value)} className="[color-scheme:dark]" />
              </Field>
            )}
            <Field label="Motif" hint="Faits reprochés, 10 caractères au moins.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={"ex.\u00a0: frais impayés depuis le…, fraude constatée le…"} />
            </Field>
          </div>
          <DialogFooter backDisabled={pending}>
            <Button variant="danger" loading={pending} onClick={() => run("suspended")}>Suspendre le client</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={archiving} onOpenChange={setArchiving}>
        <DialogContent
          title="Archiver ce client ?"
          description="Il disparaît des clients actifs : membres et chauffeurs perdent l'accès, les courses ne sont plus dispatchées. Les données et le registre des frais sont conservés ; vous pourrez le réactiver."
        >
          <DialogFooter backDisabled={pending}>
            <Button variant="danger" loading={pending} onClick={() => run("archived")}>Archiver le client</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Ligne de la zone sensible : l'action, sa conséquence en une phrase, puis le bouton (dessous sur téléphone). */
function SensitiveRow({ title, consequence, children }: { title: string; consequence: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-0 flex-1 basis-[min(100%,20rem)]">
        <p className="text-[13.5px] font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{frSpaces(consequence)}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </li>
  );
}

/** Flotte Privée : limites imposées par private.org_limits APRÈS l'offre et la surcharge. */
const PRIVATE_FLEET_FIXED: Record<string, number> = { max_drivers: 1, max_admins: 1 };

type OptionChoice = "plan" | "on" | "off";

/** Mêmes ajustements (ordre des clés indifférent). */
const sameLimits = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => k in b && a[k] === b[k]);

/**
 * Offre et limites d'un client (fiche du super admin) : résumé des limites EFFECTIVES (offre, ajustements, puis
 * Flotte Privée), offre, puis « Ajuster une limite pour ce client (facultatif) » replié. Nombre vide = valeur de
 * l'offre (clé retirée) ; option « Selon l'offre » = clé retirée, « Forcer : oui / non » = vrai / faux. Même structure
 * envoyée qu'avant (updateOrganizationPlan : offre + surcharge). Flotte Privée : 1 chauffeur et 1 accès imposés par la
 * base (champs verrouillés, valeur enregistrée inchangée) ; offre sans API refusée par le serveur.
 */
export function OrganizationPlanForm({
  orgId,
  plans,
  planId,
  override,
  privateFleet = false,
}: {
  orgId: string;
  plans: { id: string; name: string; limits: Record<string, unknown> | null }[];
  planId: string | null;
  override: Record<string, unknown>;
  /** Flotte Privée : 1 chauffeur et 1 accès imposés ; offre (et surcharge) sans accès à l'API refusée */
  privateFleet?: boolean;
}) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const [plan, setPlan] = useState(planId ?? "");
  const [o, setO] = useState<Record<string, unknown>>(override ?? {});
  const chosen = plans.find((p) => p.id === plan) ?? null;
  // Sans offre : aucune limite, toutes les options (comme private.org_limits)
  const base: Record<string, unknown> = plan ? (chosen?.limits ?? {}) : NO_PLAN_LIMITS;
  const limits = effectiveLimits({ planId: plan || null, planLimits: chosen?.limits, override: o, privateFleet });
  const adjusted = Object.keys(o).filter((k) => [...PLAN_NUMBER_LIMITS, ...PLAN_OPTION_LIMITS].some((f) => f.key === k)).length;
  const dirty = (plan || null) !== (planId || null) || !sameLimits(o, override ?? {});
  const setKey = (key: string, value: unknown | undefined) =>
    setO((c) => {
      const n = { ...c };
      if (value === undefined) delete n[key];
      else n[key] = value;
      return n;
    });
  const choiceOf = (key: string): OptionChoice => (!(key in o) ? "plan" : limitEnabled(o[key]) ? "on" : "off");
  const baseText = (key: string) => {
    const v = base[key];
    return typeof v === "number" ? formatNumber(v) : "illimité";
  };

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-fg">{planSummary(chosen?.name ?? null, limits)}</p>
      <Field
        label="Offre"
        htmlFor={`${uid}-plan`}
        hint={
          privateFleet
            ? "Flotte Privée\u00a0: l'offre doit inclure l'API de réservation (le site du client réserve par l'API)."
            : plan
              ? undefined
              : "Sans offre\u00a0: aucune limite, toutes les options."
        }
      >
        <NativeSelect id={`${uid}-plan`} value={plan} onChange={(e) => setPlan(e.target.value)} disabled={pending}>
          <option value="">Sans offre</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {privateFleet && !limitEnabled(p.limits?.api_access) ? `${p.name} (sans API)` : p.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Disclosure
        title="Ajuster une limite pour ce client (facultatif)"
        hint={adjusted ? plural(adjusted, "limite ajustée", "limites ajustées") : undefined}
        className="rounded-xl border border-line px-4"
        contentClassName="space-y-4 pb-4 pt-1"
      >
        <p className="text-[12.5px] text-fg-muted">Vide ou «{"\u00a0"}Selon l&apos;offre{"\u00a0"}»{"\u00a0"}: la valeur de l&apos;offre s&apos;applique.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {PLAN_NUMBER_LIMITS.map((f) => {
            const fixed = privateFleet ? PRIVATE_FLEET_FIXED[f.key] : undefined;
            const value = o[f.key];
            return (
              <Field
                key={f.key}
                label={f.label}
                hint={fixed !== undefined ? `Imposé\u00a0: ${fixed} (Flotte Privée)` : `${plan ? "Selon l'offre" : "Sans offre"}\u00a0: ${baseText(f.key)}`}
              >
                {fixed !== undefined ? (
                  // Affichage seulement : la valeur enregistrée (renvoyée telle quelle) n'a aucun effet, la base impose 1
                  <Input type="number" value={fixed} disabled readOnly className="num" />
                ) : (
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={typeof value === "number" ? value : ""}
                    placeholder="—"
                    onChange={(e) => setKey(f.key, e.target.value === "" ? undefined : Number(e.target.value))}
                    disabled={pending}
                    className="num"
                  />
                )}
              </Field>
            );
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {PLAN_OPTION_LIMITS.map((f) => (
            <Field key={f.key} label={f.label}>
              <NativeSelect
                value={choiceOf(f.key)}
                onChange={(e) => {
                  const v = e.target.value as OptionChoice;
                  setKey(f.key, v === "plan" ? undefined : v === "on");
                }}
                disabled={pending}
              >
                <option value="plan">{`${plan ? "Selon l'offre" : "Sans offre"} (${limitEnabled(base[f.key]) ? "oui" : "non"})`}</option>
                <option value="on">{"Forcer\u00a0: oui"}</option>
                <option value="off">{"Forcer\u00a0: non"}</option>
              </NativeSelect>
            </Field>
          ))}
        </div>
      </Disclosure>
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={pending}
          disabled={!dirty}
          onClick={() =>
            start(() =>
              runAction(async () => {
                const r = await updateOrganizationPlan(orgId, plan || null, o);
                if (r.ok) {
                  toast.success("Offre mise à jour");
                  router.refresh();
                } else toast.error(r.error);
              }),
            )
          }
        >
          Enregistrer l&apos;offre
        </Button>
      </div>
    </div>
  );
}

export function PlanEditor({ plan }: { plan: any | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const l = plan?.limits ?? {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant={plan ? "outline" : "primary"} size={plan ? "sm" : "md"} onClick={() => setOpen(true)}>{plan ? "Modifier" : "Nouvelle offre"}</Button>
      <DialogContent title={plan ? `Offre ${plan.name}` : "Nouvelle offre"} size="lg">
        <form
          onSubmit={submitWith((f) =>
            start(() => runAction(async () => {
              const num = (k: string) => (String(f.get(k) ?? "") === "" ? null : Number(f.get(k)));
              const res = await savePlan(plan?.id ?? null, {
                code: String(f.get("code")), name: String(f.get("name")), description: String(f.get("description") ?? ""),
                price_monthly_cents: Math.round(Number(f.get("monthly")) * 100), price_yearly_cents: Math.round(Number(f.get("yearly")) * 100),
                limits: {
                  max_drivers: num("max_drivers"), max_rides_per_month: num("max_rides_per_month"), max_admins: num("max_admins"),
                  api_access: f.get("api_access") === "on", booking_site: f.get("booking_site") === "on", custom_domain: f.get("custom_domain") === "on",
                  advanced_stats: f.get("advanced_stats") === "on", history_days: num("history_days"),
                },
                features: String(f.get("features") ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
                is_active: f.get("is_active") === "on", is_public: f.get("is_public") === "on", highlighted: f.get("highlighted") === "on",
              });
              if (!res.ok) return void toast.error(res.error);
              toast.success("Offre enregistrée");
              setOpen(false);
              router.refresh();
            })),
          )}
          className="grid gap-4 sm:grid-cols-2"
        >
          <Field label="Code"><Input name="code" defaultValue={plan?.code ?? ""} required className="num" /></Field>
          <Field label="Nom"><Input name="name" defaultValue={plan?.name ?? ""} required /></Field>
          <Field label="Description" className="sm:col-span-2"><Input name="description" defaultValue={plan?.description ?? ""} /></Field>
          <Field label="Prix mensuel HT (€)"><Input name="monthly" type="number" step="0.01" defaultValue={(plan?.price_monthly_cents ?? 0) / 100} className="num" /></Field>
          <Field label="Prix annuel HT (€)"><Input name="yearly" type="number" step="0.01" defaultValue={(plan?.price_yearly_cents ?? 0) / 100} className="num" /></Field>
          <Field label="Chauffeurs max." hint="vide = illimité"><Input name="max_drivers" type="number" defaultValue={l.max_drivers ?? ""} className="num" /></Field>
          <Field label="Courses / mois" hint="vide = illimité"><Input name="max_rides_per_month" type="number" defaultValue={l.max_rides_per_month ?? ""} className="num" /></Field>
          <Field label="Administrateurs max."><Input name="max_admins" type="number" defaultValue={l.max_admins ?? ""} className="num" /></Field>
          <Field label="Historique (jours)"><Input name="history_days" type="number" defaultValue={l.history_days ?? ""} className="num" /></Field>
          <div className="grid grid-cols-2 gap-2 sm:col-span-2">
            {[["api_access", "API"], ["booking_site", "Mini-site"], ["custom_domain", "Domaine personnalisé"], ["advanced_stats", "Statistiques avancées"], ["is_active", "Offre active"], ["is_public", "Visible publiquement"], ["highlighted", "Mise en avant"]].map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[12.5px]">
                <input type="checkbox" name={k} defaultChecked={k in l ? Boolean(l[k]) : Boolean(plan?.[k] ?? (k === "is_active" || k === "is_public"))} className="accent-[var(--color-brand)]" /> {label}
              </label>
            ))}
          </div>
          <Field label="Arguments (1 par ligne)" className="sm:col-span-2"><Textarea name="features" defaultValue={(plan?.features ?? []).join("\n")} /></Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" variant="primary" loading={pending}>Enregistrer</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
