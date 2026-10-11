"use client";
// Super admin — Flotte Privée (docs/FLOTTE-PRIVEE.md § 8 et § 9.4) : formulaire « Nouveau client Flotte Privée »,
// clés du site du client (création après CGV et accord de traitement, affichée une fois avec l'extrait d'intégration,
// révocation), fiche du gérant recréée, lien d'accès renvoyé, « Changer d'offre de service » (PackConversionDialog).
// Actions serveur : app/admin/flotte-privee/actions.ts ; règles pures : private-fleet-state.ts ; cartes de la fiche :
// private-fleet-card.tsx.
import {
  PRIVATE_FLEET_BLOCKER_LABELS, PRIVATE_FLEET_BLOCKERS, PRIVATE_FLEET_SITE_KEY_MAX_ORIGINS, VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META, addIsoDays,
  formatNumber, isoDayLabel, slugify, type AdminPlatformFeeSchedule, type PrivateFleetBlocker, type PrivateFleetSiteKeyKind,
  type PrivateFleetSwitchTarget, type VehicleCategory,
} from "@rydar/shared";
import { AlertTriangle, Check, Copy, KeyRound, Mail, Plus, ShieldAlert, Sparkles, Trash2, UserPlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  attachPrivateFleetDriver, createPrivateFleet, createPrivateFleetSiteKey, resendPrivateFleetAccess, revokePrivateFleetSiteKey, setPrivateFleet,
} from "@/app/admin/flotte-privee/actions";
import { FeeFields, feeRule } from "@/components/admin/dispatch-model";
import { feeChangePlan } from "@/components/admin/fee-change-plan";
import { centsToInput, percentToInput, readFees } from "@/components/admin/fees";
import {
  SITE_KEY_KIND_META, SITE_KEY_RATE, SITE_KEY_RATE_LABEL, SWITCH_TARGET_META, conversionSummary, siteKeySnippet, type PrivateFleetPrefill,
} from "@/components/admin/private-fleet-state";
import { frSpaces } from "@/components/platform-fees/org-platform-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, SheetContent } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { FormSection } from "@/components/ui/form-section";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

/** Offre proposée : active, avec ou sans accès à l'API (sans API : refusée en Flotte Privée). */
export type PlanOption = { id: string; name: string; api: boolean };

const fieldOf = (f: FormData) => (k: string) => String(f.get(k) ?? "").trim();

// -----------------------------------------------------------------------------
// Fiche du gérant et véhicule (création et recréation)
// -----------------------------------------------------------------------------
export type DriverPrefill = {
  ownerFirstName?: string;
  ownerLastName?: string;
  ownerPhone?: string;
  vtcCardNumber?: string;
  vehicle?: { brand?: string; model?: string; color?: string; plate?: string; category?: VehicleCategory; seats?: number; luggageCapacity?: number };
};

/** Champs du chauffeur-propriétaire (sans l'e-mail, propre à la création) et de son véhicule. */
function DriverFields({ prefill, errors, emailField }: { prefill?: DriverPrefill; errors: Record<string, string>; emailField?: React.ReactNode }) {
  const v = prefill?.vehicle;
  return (
    <>
      <div className="grid gap-4 rounded-xl border border-line bg-white/[0.02] p-4 sm:grid-cols-2">
        <p className="text-[13px] font-medium text-fg-muted sm:col-span-2">Chauffeur-propriétaire</p>
        <Field label="Prénom" error={errors.ownerFirstName}>
          <Input name="ownerFirstName" required defaultValue={prefill?.ownerFirstName} autoComplete="off" />
        </Field>
        <Field label="Nom" error={errors.ownerLastName}>
          <Input name="ownerLastName" required defaultValue={prefill?.ownerLastName} autoComplete="off" />
        </Field>
        {emailField}
        <Field label="Téléphone" error={errors.ownerPhone}>
          <Input name="ownerPhone" type="tel" required defaultValue={prefill?.ownerPhone} autoComplete="off" />
        </Field>
        <Field label="N° de carte VTC" optional error={errors.vtcCardNumber}>
          <Input name="vtcCardNumber" defaultValue={prefill?.vtcCardNumber} className="num" autoComplete="off" />
        </Field>
      </div>
      <div className="grid gap-4 rounded-xl border border-line bg-white/[0.02] p-4 sm:grid-cols-2">
        <p className="text-[13px] font-medium text-fg-muted sm:col-span-2">Véhicule</p>
        <Field label="Marque" optional error={errors["vehicle.brand"]}>
          <Input name="brand" defaultValue={v?.brand} autoComplete="off" />
        </Field>
        <Field label="Modèle" error={errors["vehicle.model"]}>
          <Input name="model" required defaultValue={v?.model} autoComplete="off" />
        </Field>
        <Field label="Couleur" optional error={errors["vehicle.color"]}>
          <Input name="color" defaultValue={v?.color} autoComplete="off" />
        </Field>
        <Field label="Plaque" error={errors["vehicle.plate"]}>
          <Input name="plate" required defaultValue={v?.plate} className="num uppercase" autoComplete="off" />
        </Field>
        <Field label="Catégorie" error={errors["vehicle.category"]} hint="Le site ne propose que cette catégorie.">
          <NativeSelect name="category" required defaultValue={v?.category ?? ""}>
            <option value="" disabled>
              Choisir…
            </option>
            {VEHICLE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {VEHICLE_CATEGORY_META[c].label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Places" error={errors["vehicle.seats"]}>
            <Input name="seats" type="number" min={1} max={20} required defaultValue={v?.seats ?? 4} className="num" />
          </Field>
          <Field label="Bagages" error={errors["vehicle.luggageCapacity"]}>
            <Input name="luggageCapacity" type="number" min={0} max={30} required defaultValue={v?.luggageCapacity ?? 3} className="num" />
          </Field>
        </div>
      </div>
    </>
  );
}

/** Fiche du gérant et véhicule lus dans le formulaire (privateFleetDriverSchema). */
function readDriver(f: FormData) {
  const g = fieldOf(f);
  return {
    ownerFirstName: g("ownerFirstName"),
    ownerLastName: g("ownerLastName"),
    ownerPhone: g("ownerPhone"),
    vtcCardNumber: g("vtcCardNumber"),
    vehicle: {
      brand: g("brand"),
      model: g("model"),
      color: g("color"),
      plate: g("plate"),
      category: g("category") as VehicleCategory,
      seats: g("seats"),
      luggageCapacity: g("luggageCapacity"),
    },
  };
}

// -----------------------------------------------------------------------------
// Création
// -----------------------------------------------------------------------------

/**
 * « Nouveau client Flotte Privée » : client, chauffeur-propriétaire (compte neuf, invité par e-mail), véhicule, frais
 * Rydar par course (0 par défaut : aucun montant proposé), offre facultative avec l'API, référence du contrat signé.
 * Ouverture : par « Nouveau client » de la liste des clients (`open` / `onOpenChange`, sans bouton propre ;
 * components/admin/new-client.tsx) ou par son propre bouton (`label`), depuis une demande de contact
 * (`contactRequestId`) : formulaire prérempli, demande marquée traitée après la création. Sections numérotées
 * (docs/REFONTE-PANELS.md, R3) ; champs, libellés, charge envoyée et fieldErrors inchangés.
 */
export function CreatePrivateFleetSheet({
  plans,
  rootDomain,
  prefill,
  contactRequestId,
  label = "Nouveau client Flotte Privée",
  open: openProp,
  onOpenChange,
}: {
  plans: PlanOption[];
  /** NEXT_PUBLIC_ROOT_DOMAIN (indice de l'identifiant) */
  rootDomain: string;
  prefill?: PrivateFleetPrefill;
  contactRequestId?: string;
  label?: string;
  /** Ouverture pilotée (« Nouveau client ») : pas de bouton propre */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const uid = useId();
  const controlled = openProp !== undefined;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled ? openProp : ownOpen;
  const setOpen = (o: boolean) => (controlled ? onOpenChange?.(o) : setOwnOpen(o));
  const [pending, start] = useTransition();
  const [name, setName] = useState(prefill?.name ?? "");
  const [slug, setSlug] = useState(prefill?.name ? slugify(prefill.name) : "");
  const [touched, setTouched] = useState(false);
  const [feePercent, setFeePercent] = useState("0");
  const [feeFixed, setFeeFixed] = useState("0");
  const [temporary, setTemporary] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (f: FormData) =>
    start(() =>
      runAction(async () => {
        const g = fieldOf(f);
        const fees = readFees(feePercent, feeFixed);
        if (!fees.valid) return void setErrors({ platformFeePercent: fees.errors.percent ?? "", platformFeeFixedCents: fees.errors.fixed ?? "" });
        setErrors({});
        const res = await createPrivateFleet(
          {
            name,
            slug,
            email: g("email"),
            phone: g("phone"),
            city: g("city"),
            legalName: g("legalName"),
            siret: g("siret"),
            vtcRegistration: g("vtcRegistration"),
            ownerEmail: g("ownerEmail"),
            ...readDriver(f),
            platformFeePercent: fees.percent,
            platformFeeFixedCents: fees.fixedCents,
            planId: g("planId"),
            contractRef: g("contractRef"),
            temporaryPassword: temporary,
            password: temporary ? String(f.get("password") ?? "") : "",
          },
          contactRequestId ?? null,
        );
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          return void toast.error(res.error);
        }
        toast.success(frSpaces(`Client Flotte Privée créé : ${res.name}`), { description: res.message, duration: 15_000 });
        if (res.contactUpdated === false) {
          toast.warning(frSpaces("La demande de contact n'a pas pu être marquée « traitée » : faites-le dans « Suivi »."));
        }
        setOpen(false);
        router.push(`/admin/organizations/${res.id}`);
      }),
    );

  // Informations légales repliées (facultatives) : ouvertes d'office si l'une d'elles est refusée
  const legalError = !!(errors.legalName || errors.siret || errors.vtcRegistration);

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      {!controlled && (
        <Button variant={contactRequestId ? "primary" : "outline"} onClick={() => setOpen(true)} className={contactRequestId ? "w-full" : undefined}>
          <Sparkles /> {label}
        </Button>
      )}
      <SheetContent
        title="Nouveau client Flotte Privée"
        description={frSpaces("Un chauffeur VTC indépendant : une seule fiche (la sienne, sur son compte), les réservations de son site rien que pour lui.")}
      >
        <form onSubmit={submitWith(submit)} className="space-y-7 px-6 py-6">
          <FormSection step={1} title="Client">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom commercial" className="sm:col-span-2" error={errors.name}>
                <Input
                  value={name}
                  required
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!touched) setSlug(slugify(e.target.value));
                  }}
                  placeholder={"ex.\u00a0: VTC Martin"}
                  autoComplete="off"
                />
              </Field>
              <Field label="Identifiant" hint={`${slug || "identifiant"}.${rootDomain}`} error={errors.slug}>
                <Input
                  value={slug}
                  required
                  onChange={(e) => {
                    setTouched(true);
                    setSlug(slugify(e.target.value));
                  }}
                  className="num"
                  autoComplete="off"
                />
              </Field>
              <Field label="Ville" error={errors.city}>
                <Input name="city" required maxLength={80} autoComplete="off" />
              </Field>
              <Field label="E-mail du client" error={errors.email} hint="Adresse de l'entreprise (factures, annonces des frais).">
                <Input name="email" type="email" required defaultValue={prefill?.email} autoComplete="off" />
              </Field>
              <Field label="Téléphone du client" error={errors.phone}>
                <Input name="phone" type="tel" required defaultValue={prefill?.phone} autoComplete="off" />
              </Field>
            </div>
            <Disclosure
              title="Informations légales (facultatif)"
              hint={<span className="max-sm:hidden">raison sociale, SIRET, n° VTC</span>}
              forceOpen={legalError}
              className="rounded-xl border border-line px-4"
              contentClassName="grid gap-4 pb-4 pt-1 sm:grid-cols-2"
            >
              <Field label="Raison sociale" optional error={errors.legalName}>
                <Input name="legalName" autoComplete="off" />
              </Field>
              <Field label="SIRET" optional error={errors.siret} hint="14 chiffres.">
                <Input name="siret" inputMode="numeric" className="num" autoComplete="off" />
              </Field>
              <Field label="N° d'inscription au registre VTC" optional className="sm:col-span-2" error={errors.vtcRegistration}>
                <Input name="vtcRegistration" className="num" autoComplete="off" />
              </Field>
            </Disclosure>
          </FormSection>

          <FormSection step={2} title="Chauffeur et véhicule">
            <DriverFields
              prefill={prefill}
              errors={errors}
              emailField={
                <Field
                  label="E-mail de connexion"
                  className="sm:col-span-2"
                  error={errors.ownerEmail}
                  hint={frSpaces("Adresse sans compte Rydar : elle sert à l'espace web ET à l'application (mêmes identifiants).")}
                >
                  <Input name="ownerEmail" type="email" required defaultValue={prefill?.ownerEmail} autoComplete="off" />
                </Field>
              }
            />
          </FormSection>

          <FormSection step={3} title="Offre et frais">
            <Field label="Offre" optional error={errors.planId} hint={frSpaces("Offre avec l'accès à l'API (le site réserve par l'API). Sans offre : aucune limite, sauf 1 chauffeur et 1 accès.")}>
              <NativeSelect name="planId" defaultValue="">
                <option value="">Sans offre</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.api}>
                    {p.api ? p.name : `${p.name} (sans API)`}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="rounded-xl border border-line bg-white/[0.02] p-4">
              <p className="mb-1 text-[13px] font-medium text-fg">Frais Rydar par course</p>
              <p className="mb-3 text-[12.5px] leading-relaxed text-fg-muted">{feeRule("fleet")}</p>
              <FeeFields
                model="fleet"
                percent={feePercent}
                fixed={feeFixed}
                onPercent={setFeePercent}
                onFixed={setFeeFixed}
                errors={{ percent: errors.platformFeePercent, fixed: errors.platformFeeFixedCents }}
                disabled={pending}
              />
            </div>
          </FormSection>

          <FormSection step={4} title="Accès et contrat">
            <Field
              label="Référence du contrat signé"
              error={errors.contractRef}
              hint="Conditions particulières Flotte Privée et contrat de prestations, signés avant toute activation."
            >
              <Input name="contractRef" required minLength={3} maxLength={200} autoComplete="off" />
            </Field>
            <div className="space-y-3 rounded-xl border border-line bg-white/[0.02] p-4">
              <p className="text-[13px] font-medium text-fg">Accès du client</p>
              <p className="text-[12.5px] leading-relaxed text-fg-muted">
                {frSpaces(
                  "Par défaut : invitation par e-mail. Le client choisit son mot de passe, accepte les CGV dans son espace web, puis se connecte à l'application avec les mêmes identifiants.",
                )}
              </p>
              <label htmlFor={`${uid}-temporary`} className="flex cursor-pointer items-start gap-2.5">
                <input
                  id={`${uid}-temporary`}
                  type="checkbox"
                  checked={temporary}
                  onChange={(e) => setTemporary(e.target.checked)}
                  className="mt-1 size-4 shrink-0 accent-brand"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-fg">Mot de passe provisoire (serveur sans e-mail)</span>
                  <span className="block text-[12.5px] leading-[18px] text-amber">
                    {frSpaces(
                      "Accès connu de l'équipe : à transmettre au client, qui doit le changer par « Mot de passe oublié » dès sa première connexion. À n'utiliser que si l'envoi des e-mails n'est pas configuré.",
                    )}
                  </span>
                </span>
              </label>
              {temporary && (
                <Field label="Mot de passe provisoire" error={errors.password} hint="10 caractères au moins.">
                  <Input name="password" type="text" required minLength={10} maxLength={72} className="num" autoComplete="new-password" />
                </Field>
              )}
            </div>
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

// -----------------------------------------------------------------------------
// Clés du site
// -----------------------------------------------------------------------------
export type SiteKeyRow = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  kind: PrivateFleetSiteKeyKind;
  origins: string[];
  /** Débit de la clé (requêtes par minute ; clé navigateur : par portée, devis et réservations à part) */
  rateLimitPerMinute: number;
  /** « utilisée il y a 3 min », « jamais utilisée » (calculé au rendu serveur) */
  lastUsedLabel: string;
  createdLabel: string;
  state: "active" | "expired" | "revoked";
  revokedLabel: string | null;
};

const STATE_META: Record<SiteKeyRow["state"], { label: string; tone: "green" | "amber" | "neutral" }> = {
  active: { label: "Active", tone: "green" },
  expired: { label: "Expirée", tone: "amber" },
  revoked: { label: "Révoquée", tone: "neutral" },
};

/** Bouton « Copier » (presse-papiers), état confirmé 1,5 s. */
function CopyText({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="text-brand" /> : <Copy />} {done ? "Copié" : label}
    </Button>
  );
}

/**
 * Clés du site du client (D16 : gérées par l'équipe Rydar). Création possible seulement après l'acceptation des CGV
 * et de l'accord de traitement (`blockedReason` sinon), débit réglable (défaut selon le type de clé) ; la clé complète
 * et l'extrait d'intégration ne sont affichés qu'une fois ; révocation immédiate.
 */
export function SiteKeysPanel({ orgId, keys, blockedReason, apiBase }: { orgId: string; keys: SiteKeyRow[]; blockedReason: string | null; apiBase: string }) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [kind, setKind] = useState<PrivateFleetSiteKeyKind>("server");
  const [rate, setRate] = useState(String(SITE_KEY_RATE.server.default));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<{ key: string; kind: PrivateFleetSiteKeyKind; origins: string[] } | null>(null);
  const [revoking, setRevoking] = useState<SiteKeyRow | null>(null);

  const create = (f: FormData) =>
    start(() =>
      runAction(async () => {
        const origins = String(f.get("origins") ?? "")
          .split(/[\s,]+/)
          .map((o) => o.trim())
          .filter(Boolean);
        const res = await createPrivateFleetSiteKey(orgId, {
          kind,
          name: String(f.get("name") ?? ""),
          origins: kind === "browser" ? origins : [],
          rateLimitPerMinute: rate,
        });
        if (!res.ok) {
          // Erreur d'une origine (« origins.2 ») : affichée sous le champ
          const fe = res.fieldErrors ?? {};
          const originError = Object.entries(fe).find(([k]) => k.startsWith("origins"))?.[1];
          setErrors({ ...fe, origins: originError ?? "" });
          return void toast.error(res.error);
        }
        setErrors({});
        setCreateOpen(false);
        setRevealed({ key: res.key, kind: res.kind, origins: res.origins });
        router.refresh();
      }),
    );

  const revoke = (k: SiteKeyRow) =>
    start(() =>
      runAction(async () => {
        const res = await revokePrivateFleetSiteKey(orgId, k.id);
        if (!res.ok) return void toast.error(res.error);
        toast.success(`Clé ${k.prefix} révoquée`, { description: "Le site qui l'utilisait ne peut plus réserver." });
        setRevoking(null);
        router.refresh();
      }),
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-fg-muted">{frSpaces("Le client voit ses clés en lecture seule (« Mon site ») ; création et révocation passent par l'équipe.")}</p>
        <Button variant="primary" size="sm" disabled={!!blockedReason} onClick={() => setCreateOpen(true)}>
          <Plus /> Nouvelle clé
        </Button>
      </div>
      {blockedReason && (
        <p className="flex items-start gap-2 rounded-lg border border-amber/25 bg-amber/[0.06] px-3 py-2 text-[12.5px] text-fg-muted">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber" />
          <span>{frSpaces(blockedReason)}</span>
        </p>
      )}
      <ul className="divide-y divide-line rounded-xl border border-line">
        {keys.length === 0 && (
          <li className="flex items-center gap-3 px-4 py-5 text-[13px] text-fg-muted">
            <KeyRound aria-hidden className="size-4" /> {frSpaces("Aucune clé : le site du client ne peut pas encore réserver.")}
          </li>
        )}
        {keys.map((k) => (
          <li key={k.id} className={cn("flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3", k.state !== "active" && "opacity-70")}>
            <div className="min-w-[180px] flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-fg">
                {k.name}
                <Badge tone={k.kind === "browser" ? "amber" : "blue"} dot={false}>
                  {SITE_KEY_KIND_META[k.kind].label}
                </Badge>
              </p>
              <p className="mono text-[12px] text-fg-muted">
                {k.prefix}_••••{k.last4} · {formatNumber(k.rateLimitPerMinute)} req/min
              </p>
              {k.origins.length > 0 && <p className="mt-0.5 text-[12px] text-fg-muted [overflow-wrap:anywhere]">{k.origins.join(", ")}</p>}
            </div>
            <div className="text-right text-[12px] text-fg-muted">
              <p>{k.lastUsedLabel}</p>
              <p>{k.revokedLabel ?? k.createdLabel}</p>
            </div>
            <Badge tone={STATE_META[k.state].tone}>{STATE_META[k.state].label}</Badge>
            {k.state === "active" && (
              <Button variant="ghost" size="icon-sm" aria-label={`Révoquer la clé ${k.prefix}`} title="Révoquer" onClick={() => setRevoking(k)}>
                <Trash2 className="text-red" />
              </Button>
            )}
          </li>
        ))}
      </ul>

      <Dialog open={createOpen} onOpenChange={(o) => !pending && setCreateOpen(o)}>
        <DialogContent title="Nouvelle clé du site" description="La clé complète ne sera affichée qu'une fois, avec l'extrait d'intégration.">
          <form onSubmit={submitWith(create)} className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="mb-1 text-[12.5px] font-medium text-fg-muted">Type de clé</legend>
              {(["server", "browser"] as const).map((k) => (
                <label key={k} htmlFor={`${uid}-${k}`} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-3">
                  <input
                    id={`${uid}-${k}`}
                    type="radio"
                    name={`${uid}-kind`}
                    checked={kind === k}
                    onChange={() => {
                      setKind(k);
                      setRate(String(SITE_KEY_RATE[k].default));
                    }}
                    className="mt-1 size-4 shrink-0 accent-brand"
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-fg">{SITE_KEY_KIND_META[k].label}</span>
                    <span className="block text-[12px] leading-[18px] text-fg-muted">{frSpaces(SITE_KEY_KIND_META[k].description)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <Field label="Nom" error={errors.name}>
              <Input name="name" required minLength={2} maxLength={80} defaultValue="Site du client" />
            </Field>
            {kind === "browser" && (
              <Field
                label="Adresses du site"
                error={errors.origins || undefined}
                hint={frSpaces(`https:// et nom de domaine, sans chemin (une par ligne, ${PRIVATE_FLEET_SITE_KEY_MAX_ORIGINS} au plus) ; la variante www est ajoutée.`)}
              >
                <Textarea name="origins" required placeholder="https://monsite.fr" className="min-h-[72px]" />
              </Field>
            )}
            <Field label={SITE_KEY_RATE_LABEL} error={errors.rateLimitPerMinute} hint={frSpaces(SITE_KEY_RATE[kind].hint)}>
              <Input
                name="rateLimitPerMinute"
                type="number"
                inputMode="numeric"
                required
                min={SITE_KEY_RATE[kind].min}
                max={SITE_KEY_RATE[kind].max}
                step={1}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className="num max-w-[160px]"
              />
            </Field>
            {/* « Retour » ferme sans rien faire (« Annuler » est réservé aux actions métier) ; empilés sous 640 px */}
            <DialogFooter backDisabled={pending}>
              <Button type="submit" variant="primary" loading={pending}>
                Générer la clé
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent
          size="lg"
          title={revealed ? SITE_KEY_KIND_META[revealed.kind].label : "Clé du site"}
          description={frSpaces("Copiez-la maintenant : elle ne sera plus jamais affichée (seul un hash est conservé).")}
        >
          {revealed && (
            <div className="space-y-4">
              <div className="rounded-xl border border-brand/30 bg-brand/[0.05] p-4">
                <p className="mono break-all text-[13px] text-fg">{revealed.key}</p>
              </div>
              {revealed.kind === "server" ? (
                <p className="flex items-start gap-2 text-[12px] text-amber">
                  <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {frSpaces("Clé serveur : à placer dans une variable d'environnement du serveur du site, jamais dans le code envoyé au navigateur.")}
                </p>
              ) : (
                <p className="text-[12px] text-fg-muted">
                  {frSpaces(`Utilisable seulement depuis : ${revealed.origins.join(", ")}.`)}
                </p>
              )}
              <CodeBlock
                language={revealed.kind === "server" ? "bash" : "javascript"}
                code={siteKeySnippet({ kind: revealed.kind, apiBase, key: revealed.key, origin: revealed.origins[0] ?? null })}
              />
              <DialogFooter hideBack className="mt-0">
                <CopyText value={revealed.key} label="Copier la clé" />
                <Button variant="primary" onClick={() => setRevealed(null)}>
                  J&apos;ai copié la clé
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmation qui dit la conséquence, bouton qui nomme l'action (comme dans l'espace du client) */}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !pending && !o && setRevoking(null)}
        title={frSpaces(revoking ? `Révoquer la clé ${revoking.prefix} ?` : "Révoquer la clé ?")}
        consequence={frSpaces("Immédiat : le site qui l'utilise ne peut plus ni demander de devis ni réserver.")}
        confirmLabel="Révoquer la clé"
        loading={pending}
        onConfirm={() => revoking && revoke(revoking)}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Fiche du gérant et accès du propriétaire
// -----------------------------------------------------------------------------

/** « Recréer la fiche chauffeur » : sur le compte du propriétaire actif (après une suppression de compte chauffeur). */
export function RecreateDriverButton({ orgId, prefill }: { orgId: string; prefill?: DriverPrefill }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = (f: FormData) =>
    start(() =>
      runAction(async () => {
        const res = await attachPrivateFleetDriver(orgId, readDriver(f));
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          return void toast.error(res.error);
        }
        setErrors({});
        toast.success("Fiche chauffeur recréée", { description: "Les réservations du site lui sont de nouveau proposées." });
        setOpen(false);
        router.refresh();
      }),
    );
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <UserPlus /> Recréer la fiche chauffeur
      </Button>
      <SheetContent
        title="Recréer la fiche chauffeur"
        description={frSpaces("Sur le compte du propriétaire (mêmes identifiants) ; e-mail de la fiche : celui du compte. Niveau « Confirmé », fiche active.")}
      >
        <form onSubmit={submitWith(submit)} className="space-y-6 px-6 py-6">
          <DriverFields prefill={prefill} errors={errors} />
          <DialogFooter backDisabled={pending}>
            <Button type="submit" variant="primary" loading={pending}>
              Recréer la fiche
            </Button>
          </DialogFooter>
        </form>
      </SheetContent>
    </Dialog>
  );
}

/** Nouveau lien « choisir son mot de passe » pour un propriétaire qui ne s'est encore jamais connecté. */
export function ResendAccessButton({ orgId }: { orgId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      loading={pending}
      onClick={() =>
        start(() =>
          runAction(async () => {
            const res = await resendPrivateFleetAccess(orgId);
            if (!res.ok) return void toast.error(res.error);
            toast.success(`Lien d'accès renvoyé à ${res.email}`);
          }),
        )
      }
    >
      <Mail /> Renvoyer le lien d&apos;accès
    </Button>
  );
}

// -----------------------------------------------------------------------------
// Changer d'offre de service (PackConversionDialog)
// -----------------------------------------------------------------------------
export type PackConversionProps = {
  orgId: string;
  /** Cibles proposées : depuis la Flotte Privée, flotte et centrale ; depuis une organisation standard, Flotte Privée */
  targets: PrivateFleetSwitchTarget[];
  plans: PlanOption[];
  planId: string | null;
  feePercent: number;
  feeFixedCents: number;
  /** admin_platform_fee_schedule (null : lecture impossible, la base calcule seule la date d'effet) */
  schedule: AdminPlatformFeeSchedule | null;
  /** Aujourd'hui (« AAAA-MM-JJ », fuseau de l'organisation) */
  today: string;
  timeZone: string;
  /** Réservations en recherche (SEARCHING_DRIVER, OFFERED) */
  openRides: number;
  /** Entrée : raisons indicatives (private_fleet_blockers), accès à l'API de l'offre actuelle */
  blockers?: PrivateFleetBlocker[];
  apiAccess?: boolean;
};

/** Boutons « Passer en … » et dialogue « Changer d'offre de service ». */
export function PackConversionButtons(props: PackConversionProps) {
  const [target, setTarget] = useState<PrivateFleetSwitchTarget | null>(null);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {props.targets.map((t) => (
          <Button key={t} variant={t === "private_fleet" ? "primary" : "outline"} size="sm" onClick={() => setTarget(t)}>
            {SWITCH_TARGET_META[t].action}
          </Button>
        ))}
      </div>
      {target && <PackConversionDialog {...props} key={target} target={target} onClose={() => setTarget(null)} />}
    </>
  );
}

function PackConversionDialog({
  orgId,
  target,
  onClose,
  plans,
  planId,
  feePercent,
  feeFixedCents,
  schedule,
  today,
  timeZone,
  openRides,
  blockers,
  apiAccess,
}: PackConversionProps & { target: PrivateFleetSwitchTarget; onClose: () => void }) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const exit = target !== "private_fleet";
  const model = target === "centrale" ? "centrale" : "fleet";
  const [plan, setPlan] = useState(planId && plans.some((p) => p.id === planId) ? planId : "");
  const [acceptNoPlan, setAcceptNoPlan] = useState(false);
  const [percent, setPercent] = useState(percentToInput(feePercent));
  const [fixed, setFixed] = useState(centsToInput(feeFixedCents));
  const [mode, setMode] = useState<"notice" | "consent">("notice");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<PrivateFleetBlocker[] | null>(null);

  const summary = conversionSummary(target);
  const fees = readFees(percent, fixed);
  const ratesTouched = percent !== percentToInput(feePercent) || fixed !== centsToInput(feeFixedCents);
  const maxEffectiveOn = addIsoDays(today, 366);
  const feePlan = feeChangePlan({
    current: { percent: Number(feePercent), fixedCents: feeFixedCents },
    next: exit && fees.valid ? { percent: fees.percent, fixedCents: fees.fixedCents } : null,
    schedule: schedule ? { min_effective_on: schedule.min_effective_on, min_reason: schedule.min_reason, scheduled: schedule.scheduled } : null,
    mode,
    effectiveOn,
    maxEffectiveOn,
  });
  const increase = feePlan.kind === "increase";
  const chosen = plans.find((p) => p.id === plan) ?? null;
  const shownBlockers = refused ?? blockers ?? [];

  const save = () =>
    start(() =>
      runAction(async () => {
        if (exit && ratesTouched && !fees.valid) return void setErrors({ platformFeePercent: fees.errors.percent ?? "", platformFeeFixedCents: fees.errors.fixed ?? "" });
        if (note.trim().length < 3) return void setErrors({ consentNote: "Précisez la demande ou l'accord écrit du client (date et forme)." });
        if (exit && !plan && !acceptNoPlan) return void setErrors({ planId: "Choisissez une offre, ou confirmez qu'aucune limite ne s'appliquera." });
        if (exit && increase && mode === "notice" && feePlan.dateError) return void setErrors({ effectiveOn: feePlan.dateError });
        setErrors({});
        const res = await setPrivateFleet(orgId, {
          target,
          planId: exit ? plan : null,
          acceptNoPlan: exit && !plan && acceptNoPlan,
          // Taux inchangés : non envoyés (une hausse déjà annoncée reste prévue ; renvoyer les taux actuels l'annulerait)
          platformFeePercent: exit && feePlan.sendRates ? fees.percent : null,
          platformFeeFixedCents: exit && feePlan.sendRates ? fees.fixedCents : null,
          mode: increase ? mode : "notice",
          effectiveOn: increase && mode === "notice" ? feePlan.sendOn : null,
          consentNote: note,
        });
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          if (res.minEffectiveOn) setEffectiveOn(res.minEffectiveOn);
          // Refus de la base : conditions non remplies affichées en rouge dans la liste
          if (res.blockers?.length) {
            setRefused(res.blockers);
            return void toast.error(frSpaces("Passage en Flotte Privée impossible : conditions non remplies (en rouge)."));
          }
          return void toast.error(res.error);
        }
        toast.success(res.code === "UNCHANGED" ? "Aucun changement" : "Offre de service changée", { description: res.message, duration: 12_000 });
        onClose();
        router.refresh();
      }),
    );

  return (
    <Dialog open onOpenChange={(o) => !pending && !o && onClose()}>
      <DialogContent
        size="lg"
        title={frSpaces(`${SWITCH_TARGET_META[target].action} ?`)}
        description={frSpaces("Changer d'offre de service : sur place, sans perte de données, à la demande ou avec l'accord écrit du client.")}
      >
        <form onSubmit={submitWith(() => save())} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[12.5px] font-medium text-fg">Ce qui change</p>
              <ul className="space-y-1.5 text-[12.5px] text-fg-muted">
                {summary.changes.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span aria-hidden className="text-amber">•</span>
                    <span>{frSpaces(c)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1.5 text-[12.5px] font-medium text-fg">Ce qui reste</p>
              <ul className="space-y-1.5 text-[12.5px] text-fg-muted">
                {summary.keeps.map((c) => (
                  <li key={c} className="flex gap-2">
                    <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-green" />
                    <span>{frSpaces(c)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {!exit && (
            <div className="rounded-lg border border-line bg-white/[0.015] p-3.5">
              <p className="mb-1.5 text-[12.5px] font-medium text-fg">{frSpaces("Conditions (indicatives : la base fait foi)")}</p>
              <ul className="space-y-1 text-[12.5px]">
                {PRIVATE_FLEET_BLOCKERS.map((b) => {
                  const ko = shownBlockers.includes(b);
                  return (
                    <li key={b} className={cn("flex items-start gap-2", ko ? "text-red" : "text-fg-muted")}>
                      {ko ? <X aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-green" />}
                      <span>
                        <span className="sr-only">{ko ? "Non rempli : " : "Rempli : "}</span>
                        {frSpaces(ko ? PRIVATE_FLEET_BLOCKER_LABELS[b] : BLOCKER_OK[b])}
                      </span>
                    </li>
                  );
                })}
                <li className={cn("flex items-start gap-2", apiAccess === false ? "text-red" : "text-fg-muted")}>
                  {apiAccess === false ? <X aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-green" />}
                  <span>
                    <span className="sr-only">{apiAccess === false ? "Non rempli : " : "Rempli : "}</span>
                    {apiAccess === false ? frSpaces("Offre sans accès à l'API : changez d'abord l'offre (« Offre & limites »).") : "Offre avec l'accès à l'API."}
                  </span>
                </li>
              </ul>
            </div>
          )}

          {exit && (
            <>
              <div className="space-y-2">
                <Field label="Offre" htmlFor={`${uid}-plan`} error={errors.planId} hint="Ses limites s'appliquent de nouveau (la Flotte Privée imposait 1 chauffeur et 1 accès).">
                  <NativeSelect id={`${uid}-plan`} value={plan} onChange={(e) => setPlan(e.target.value)}>
                    <option value="">Sans offre</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.api ? p.name : `${p.name} (sans API)`}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                {!plan && (
                  <label htmlFor={`${uid}-noplan`} className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-fg-muted">
                    <input
                      id={`${uid}-noplan`}
                      type="checkbox"
                      checked={acceptNoPlan}
                      onChange={(e) => setAcceptNoPlan(e.target.checked)}
                      className="mt-0.5 size-4 shrink-0 accent-brand"
                    />
                    <span>{frSpaces("Sans offre : aucune limite (chauffeurs, accès, courses). Je l'assume.")}</span>
                  </label>
                )}
                {chosen && !chosen.api && (
                  <p className="flex items-start gap-2 text-[12px] text-amber">
                    <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    {frSpaces("Offre sans accès à l'API : le site du client ne pourra plus réserver.")}
                  </p>
                )}
              </div>

              <div className="space-y-3.5 rounded-xl border border-line bg-white/[0.015] p-4">
                <div>
                  <p className="mb-1 text-[13px] font-medium text-fg">Frais Rydar par course</p>
                  <p className="text-[12px] text-fg-muted">{feeRule(model)}</p>
                </div>
                <FeeFields
                  model={model}
                  percent={percent}
                  fixed={fixed}
                  onPercent={setPercent}
                  onFixed={setFixed}
                  errors={{ percent: errors.platformFeePercent, fixed: errors.platformFeeFixedCents }}
                  disabled={pending}
                />
                {increase && (
                  <fieldset className="space-y-3 rounded-lg border border-amber/25 bg-amber/[0.04] p-3.5" disabled={pending}>
                    <legend className="px-1 text-[12.5px] font-medium text-amber">Hausse des frais par course</legend>
                    {(["notice", "consent"] as const).map((m) => (
                      <label key={m} htmlFor={`${uid}-mode-${m}`} className="flex cursor-pointer items-start gap-2.5">
                        <input
                          id={`${uid}-mode-${m}`}
                          type="radio"
                          name={`${uid}-mode`}
                          checked={mode === m}
                          onChange={() => setMode(m)}
                          className="mt-1 size-4 shrink-0 accent-brand"
                        />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-fg">
                            {m === "notice" ? "Annoncer avec préavis" : frSpaces("Accord écrit du client reçu : appliquer maintenant")}
                          </span>
                          <span className="block text-[12px] leading-[18px] text-fg-muted">
                            {frSpaces(
                              m === "notice"
                                ? "Annonce par e-mail au propriétaire dès l'enregistrement, appliquée à la date d'effet (30 jours au moins)."
                                : "Appliquée dès l'enregistrement ; la note d'accord ci-dessous est gardée dans l'historique.",
                            )}
                          </span>
                        </span>
                      </label>
                    ))}
                    {mode === "notice" && (
                      <Field
                        label="Date d'effet"
                        htmlFor={`${uid}-date`}
                        error={errors.effectiveOn}
                        hint={
                          feePlan.min
                            ? frSpaces(`Au plus tôt le ${isoDayLabel(feePlan.min)}. S'applique à 00:00, heure de l'organisation (${timeZone}).`)
                            : frSpaces("Vide : la date la plus proche permise, calculée à l'enregistrement.")
                        }
                      >
                        <Input
                          id={`${uid}-date`}
                          type="date"
                          value={effectiveOn || feePlan.displayOn || ""}
                          min={feePlan.min ?? undefined}
                          max={maxEffectiveOn}
                          onChange={(e) => setEffectiveOn(e.target.value)}
                          className="num max-w-[200px] [color-scheme:dark]"
                        />
                      </Field>
                    )}
                  </fieldset>
                )}
              </div>

              {target === "centrale" && (
                <p className="flex items-start gap-2 rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2.5 text-[12.5px] text-amber">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {frSpaces(
                    "Passage en centrale : effets financiers. Frais Rydar calculés sur le prix (plafonnés au prix) ; part chauffeur, commission et règlements pour les autres chauffeurs ; les courses non closes qui ont un prix sont réparties. Le gérant ne se doit jamais de commission.",
                  )}
                </p>
              )}
            </>
          )}

          {openRides > 0 && (
            <p className="flex items-start gap-2 text-[12.5px] text-fg-muted">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber" />
              {frSpaces(
                `${openRides} réservation${openRides > 1 ? "s" : ""} en recherche : relancée${openRides > 1 ? "s" : ""} avec le nouveau profil au prochain passage du dispatch. Bascule conseillée hors recherche en cours.`,
              )}
            </p>
          )}

          <Field
            label="Note d'accord"
            htmlFor={`${uid}-note`}
            error={errors.consentNote}
            hint={frSpaces(`Demande ou accord écrit du client : date et forme (ex. « e-mail du client du 3 octobre 2026 »), CGV article 3. ${note.length}/500`)}
          >
            <Textarea id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required className="min-h-[64px]" />
          </Field>

          <DialogFooter backDisabled={pending} className="mt-0">
            <Button type="submit" variant={exit ? "danger" : "primary"} loading={pending}>
              {SWITCH_TARGET_META[target].action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Condition remplie (texte affiché à la place de la raison de refus). */
const BLOCKER_OK: Record<PrivateFleetBlocker, string> = {
  model: "Modèle flotte.",
  members: "Un seul accès : le propriétaire, actif.",
  drivers: "Une seule fiche chauffeur.",
  owner_driver: "Fiche chauffeur active sur le compte du propriétaire.",
  applications: "Aucune candidature en attente.",
  network: "Aucun réseau partagé ni demande d'adhésion.",
};
