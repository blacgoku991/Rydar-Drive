"use client";
import { slugify } from "@rydar/shared";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createOrganization, savePlan, setOrganizationStatus, updateOrganizationPlan } from "@/app/admin/actions";
import { Columns, DataTable } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, SheetContent } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";

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

export function CreateOrganizationSheet({ plans }: { plans: { code: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Building2 /> Créer un rattacheur
      </Button>
      <SheetContent title="Nouveau rattacheur" description="Espace totalement isolé : données, chauffeurs, API et mini-site dédiés.">
        <form
          action={(f) =>
            start(async () => {
              const g = (k: string) => String(f.get(k) ?? "");
              const res = await createOrganization({
                name, slug, planCode: g("plan"), email: g("email"), phone: g("phone"), city: g("city"),
                ownerName: g("ownerName"), ownerEmail: g("ownerEmail"), ownerPassword: g("ownerPassword"),
              });
              if (!res.ok) return void toast.error(res.error);
              toast.success("Rattacheur créé");
              setOpen(false);
              router.push(`/admin/organizations/${res.id}`);
            })
          }
          className="space-y-6 px-6 py-6"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nom de la centrale" className="sm:col-span-2">
              <Input value={name} required onChange={(e) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); }} placeholder="Élite Chauffeurs Paris" />
            </Field>
            <Field label="Identifiant (slug)" hint={`${slug || "slug"}.rydar.app`}>
              <Input value={slug} required onChange={(e) => { setTouched(true); setSlug(slugify(e.target.value)); }} className="num" />
            </Field>
            <Field label="Offre">
              <NativeSelect name="plan" defaultValue={plans[0]?.code}>
                {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="E-mail de la centrale"><Input name="email" type="email" required /></Field>
            <Field label="Téléphone" optional><Input name="phone" /></Field>
            <Field label="Ville" optional className="sm:col-span-2"><Input name="city" /></Field>
          </div>
          <div className="grid gap-4 rounded-xl border border-line bg-white/[0.02] p-4 sm:grid-cols-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-subtle sm:col-span-2">Compte propriétaire</p>
            <Field label="Nom complet"><Input name="ownerName" required /></Field>
            <Field label="E-mail"><Input name="ownerEmail" type="email" required /></Field>
            <Field label="Mot de passe provisoire" optional hint="Vide = invitation par e-mail" className="sm:col-span-2"><Input name="ownerPassword" className="num" /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" variant="primary" loading={pending}>Créer</Button>
          </div>
        </form>
      </SheetContent>
    </Dialog>
  );
}

export function OrganizationStatusActions({ orgId, status }: { orgId: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const run = (s: "active" | "suspended" | "archived") =>
    start(async () => {
      const res = await setOrganizationStatus(orgId, s, reason);
      if (!res.ok) return void toast.error(res.error);
      toast.success(s === "active" ? "Rattacheur réactivé" : s === "suspended" ? "Rattacheur suspendu — accès coupés" : "Rattacheur archivé");
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      {status !== "active" && <Button variant="primary" loading={pending} onClick={() => run("active")}>Réactiver</Button>}
      {status === "active" && <Button variant="danger" onClick={() => setOpen(true)}>Suspendre</Button>}
      {status !== "archived" && <Button variant="outline" loading={pending} onClick={() => run("archived")}>Archiver</Button>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Suspendre ce rattacheur" description="Membres et chauffeurs perdent immédiatement l'accès ; les courses ne sont plus dispatchées.">
          <Field label="Motif"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Impayé, demande du client…" /></Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
            <Button variant="danger" loading={pending} onClick={() => run("suspended")}>Suspendre</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

const LIMIT_FIELDS = [
  { key: "max_drivers", label: "Chauffeurs max.", type: "number" },
  { key: "max_rides_per_month", label: "Courses / mois", type: "number" },
  { key: "max_admins", label: "Administrateurs", type: "number" },
  { key: "api_access", label: "API", type: "bool" },
  { key: "booking_site", label: "Mini-site", type: "bool" },
  { key: "custom_domain", label: "Domaine perso.", type: "bool" },
  { key: "advanced_stats", label: "Stats avancées", type: "bool" },
] as const;

export function OrganizationPlanForm({ orgId, plans, planId, override }: { orgId: string; plans: { id: string; name: string; limits: any }[]; planId: string | null; override: Record<string, any> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [plan, setPlan] = useState(planId ?? plans[0]?.id ?? "");
  const [o, setO] = useState<Record<string, any>>(override ?? {});
  const base = plans.find((p) => p.id === plan)?.limits ?? {};
  return (
    <div className="space-y-4">
      <Field label="Offre">
        <NativeSelect value={plan} onChange={(e) => setPlan(e.target.value)}>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </Field>
      <p className="text-[12px] text-fg-subtle">Surcharges spécifiques (vide = valeur de l&apos;offre)</p>
      <div className="grid grid-cols-2 gap-3">
        {LIMIT_FIELDS.map((f) =>
          f.type === "number" ? (
            <Field key={f.key} label={f.label} hint={`offre : ${base[f.key] ?? "∞"}`}>
              <Input
                type="number"
                value={o[f.key] ?? ""}
                placeholder="—"
                onChange={(e) => setO((c) => { const n = { ...c }; if (e.target.value === "") delete n[f.key]; else n[f.key] = Number(e.target.value); return n; })}
                className="num"
              />
            </Field>
          ) : (
            <label key={f.key} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-[12.5px]">
              <span>{f.label} <span className="text-fg-subtle">({base[f.key] ? "oui" : "non"})</span></span>
              <Switch checked={o[f.key] ?? Boolean(base[f.key])} onCheckedChange={(v) => setO((c) => ({ ...c, [f.key]: v }))} />
            </label>
          ),
        )}
      </div>
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={pending}
          onClick={() => start(async () => { const r = await updateOrganizationPlan(orgId, plan, o); if (r.ok) { toast.success("Offre mise à jour"); router.refresh(); } else toast.error(r.error); })}
        >
          Enregistrer
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
          action={(f) =>
            start(async () => {
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
            })
          }
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
