"use client";
// Sous-onglet « Réglages » du réseau partagé : deux cartes à UN interrupteur chacune (« Partager mes courses non
// prises », « Recevoir les courses du réseau »), puis « Options avancées » repliées (plafond par chauffeur,
// organisations et chauffeurs exclus, convention). Owner / admin : modifiable ; dispatcher : lecture seule.
// Première activation : case « J'accepte la convention » + lien → demande de validation à Rydar.
import {
  NETWORK_DOCUMENTS, NETWORK_PARAMS, formatDate, formatPrice, settlementPaymentSchema, describeError,
  fieldErrors,
  type DispatchModel, type NetworkDriverExclusion, type NetworkMembership, type NetworkTermsGiverInput, type OrgNetworkDriver,
  type OrgNetworkReadiness, type SettlementMethod,
} from "@rydar/shared";
import {
  ArrowDownLeft, ArrowUpRight, ChevronDown, ExternalLink, FileCheck2, HandCoins, Info, Settings2, ShieldCheck, Timer, Undo2, Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  acceptNetworkTerms, liftNetworkDriverExclusion, setDriverNetworkAllowed, setDriverOperatorRegistration, setExecutorCreditLimit,
  setNetworkInsurance, setNetworkPartnerExcluded, setNetworkSharing, updateNetworkPaymentMethods,
} from "@/app/dashboard/reseau-partage/actions";
import { networkSearchDelayText, shareExampleText } from "@/components/network-share/example";
import { ExcludePartnerDialog } from "@/components/network-share/given-actions";
import { useNetworkRunner } from "@/components/network-share/use-network-runner";
import { SETTINGS_ANCHORS, driverReadinessView, sideSummary, termsCardUpFront } from "@/components/network-share/readiness";
import { RECEIVE_COPY, activateCopy, driverGraceHours } from "@/components/network-share/settings-copy";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import {
  SettlementMethodsFields, settlementMethodsFromRow, type SettlementMethodsValue,
} from "@/components/settlements/settlement-methods-fields";
import { METHOD_ICON, methodLabel } from "@/components/settlements/settlement-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Avatar, Switch } from "@/components/ui/misc";
import { cn, submitWith } from "@/lib/utils";

export type NetworkPaymentRow = {
  settlement_methods: SettlementMethod[] | null;
  settlement_link: string | null;
  settlement_instructions: string | null;
  settlement_payee_name: string | null;
  settlement_iban: string | null;
  settlement_bic: string | null;
};

type Props = {
  model: DispatchModel;
  canManage: boolean;
  orgName: string;
  legalName: string | null;
  currency: string;
  timeZone: string;
  readiness: OrgNetworkReadiness | null;
  membership: NetworkMembership | null;
  /** Vrais taux de l'organisation (exemple chiffré = private.network_terms) */
  rates: NetworkTermsGiverInput;
  dispatch: { radii: number[] | null; offerTimeoutSeconds: number | null; graceHours: number | null };
  payment: NetworkPaymentRow | null;
  /** org_network_drivers (owner / admin) ; null : non lu (dispatcher) */
  drivers: OrgNetworkDriver[] | null;
  driversFailed: boolean;
  partners: { id: string; name: string }[];
  excludedPartners: string[];
  driverExclusions: NetworkDriverExclusion[] | null;
  /** Nom de la personne qui a accepté la convention */
  termsAcceptedBy: string | null;
  /** Version courante de la convention (platform_settings) */
  termsVersion: string;
};

const NB = " ";

export function SettingsView(p: Props) {
  const router = useRouter();
  const { schedule } = useLiveSync(() => router.refresh(), { pollMs: 30_000, maxPollMs: 120_000, debounceMs: 600 });
  useRealtimeEvent("network.updated", schedule);
  const m = p.membership;
  const accepted = p.readiness?.terms.accepted_version ?? m?.terms_version ?? null;
  const needsTerms = accepted !== p.termsVersion;
  // Convention à (ré)accepter alors qu'un sens est demandé : bloc en tête (sinon : options avancées) ; l'en-tête de la
  // page et le bandeau du tableau de bord ne la répètent pas sur cet onglet
  const termsUpFront = termsCardUpFront(p.readiness, m, p.termsVersion);
  const [activate, setActivate] = useState<"out" | "in" | null>(null);
  const { pending, run } = useNetworkRunner();

  const toggle = (side: "out" | "in", on: boolean) => {
    if (on && needsTerms) return setActivate(side);
    run(() => setNetworkSharing({ side, enabled: on }));
  };

  return (
    <div className="space-y-6">
      {!p.canManage && (
        <p className="rounded-lg border border-line bg-white/[0.02] px-4 py-2.5 text-[12.5px] text-fg-muted">
          Lecture seule&nbsp;: seuls le propriétaire et les administrateurs modifient ces réglages.
        </p>
      )}

      {termsUpFront && (
        <TermsCard canManage={p.canManage} version={p.termsVersion} readiness={p.readiness} acceptedBy={p.termsAcceptedBy} timeZone={p.timeZone} prominent />
      )}

      <ShareCard {...p} pending={pending} onToggle={(on) => toggle("out", on)} />
      <ReceiveCard {...p} pending={pending} onToggle={(on) => toggle("in", on)} />

      <AdvancedOptions {...p} showTerms={!termsUpFront} />

      <ActivateDialog
        side={activate}
        version={p.termsVersion}
        approval={p.readiness?.approval.status ?? "none"}
        model={p.model}
        graceHours={driverGraceHours(p.dispatch.graceHours)}
        onClose={() => setActivate(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------- en-tête de carte à un interrupteur
function SwitchHeader({
  id, icon, title, description, checked, disabled, onToggle, status,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  status: { text: string; tone: "green" | "amber" | "neutral" } | null;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-violet [&_svg]:size-4">{icon}</div>
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">{description}</p>
          {status && (
            <p className={cn("mt-1.5 text-[12.5px] font-medium", status.tone === "green" ? "text-green" : status.tone === "amber" ? "text-amber" : "text-fg-subtle")}>
              {status.text}
            </p>
          )}
        </div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onToggle} aria-labelledby={`${id}-title`} className="mt-1" />
    </div>
  );
}

function sideStatus(r: OrgNetworkReadiness | null, side: "out" | "in", on: boolean): { text: string; tone: "green" | "amber" | "neutral" } | null {
  if (!on) return { text: "Désactivé", tone: "neutral" };
  if (!r) return null;
  const text = sideSummary(r, side);
  return { text, tone: text === "Actif" ? "green" : "amber" };
}

// ---------------------------------------------------------------------------- Partager mes courses non prises
function ShareCard(p: Props & { pending: boolean; onToggle: (on: boolean) => void }) {
  const on = !!p.membership?.share_out;
  const example = useMemo(() => shareExampleText(p.rates, p.currency), [p.rates, p.currency]);
  const graceHours = driverGraceHours(p.dispatch.graceHours);
  return (
    <Card id={SETTINGS_ANCHORS.share} className="scroll-mt-6">
      <SwitchHeader
        id="partager"
        icon={<ArrowUpRight />}
        title="Partager mes courses non prises"
        description="Vos chauffeurs d'abord : si aucun n'accepte, la course est proposée aux chauffeurs des organisations partenaires proches."
        checked={on}
        disabled={!p.canManage || p.pending}
        onToggle={p.onToggle}
        status={sideStatus(p.readiness, "out", on)}
      />
      <CardBody className="space-y-5">
        <div className="rounded-xl bg-white/[0.03] px-4 py-3.5">
          <p className="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-fg-subtle">Exemple avec vos taux actuels</p>
          {example.none ? (
            <p className="text-[13px] text-amber">{example.none}</p>
          ) : (
            <ul className="space-y-1.5 text-[13px]">
              {example.onBoard && (
                <li className="flex items-start gap-2">
                  <ArrowDownLeft className="mt-0.5 size-4 shrink-0 text-brand" />
                  <span>{example.onBoard}</span>
                </li>
              )}
              {example.prepaid && (
                <li className="flex items-start gap-2">
                  <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-violet" />
                  <span>{example.prepaid}</span>
                </li>
              )}
            </ul>
          )}
          <p className="mt-2.5 text-[12px] text-fg-subtle">
            Le chauffeur partenaire voit ce seul montant avant d&apos;accepter, et il ne change plus ensuite. Il vous reverse votre part sous{" "}
            {graceHours}{NB}h&nbsp;; vous lui versez la sienne sous {NETWORK_PARAMS.payoutDays}{NB}jours.
          </p>
        </div>
        <p className="flex items-start gap-2 text-[12.5px] text-fg-muted">
          <Timer className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
          {networkSearchDelayText(p.dispatch.radii, p.dispatch.offerTimeoutSeconds)}
        </p>

        <section id={SETTINGS_ANCHORS.payment} className="scroll-mt-6 space-y-3 border-t border-line pt-5" aria-labelledby="moyens-title">
          <div>
            <h3 id="moyens-title" className="flex items-center gap-2 text-[13.5px] font-semibold">
              <HandCoins className="size-4 text-fg-subtle" /> Moyens de paiement des chauffeurs partenaires
            </h3>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">
              Un chauffeur partenaire ne passe pas à vos bureaux&nbsp;: ajoutez un lien de paiement ou un RIB&nbsp;; les espèces restent possibles en plus.
            </p>
          </div>
          {p.model === "centrale" ? (
            <PaymentSummary
              payment={p.payment}
              action={
                p.canManage ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/dashboard/settings?tab=centrale" prefetch={false}>
                      <Settings2 /> Modifier
                    </Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <FleetPayment {...p} />
          )}
        </section>
      </CardBody>
    </Card>
  );
}

/** Moyen « en ligne » renseigné (lien de paiement ou RIB) : condition du partage (spec §6.1). */
function hasOnlineMethod(payment: NetworkPaymentRow | null): boolean {
  const methods = payment?.settlement_methods ?? [];
  return (methods.includes("link") && !!payment?.settlement_link) || (methods.includes("transfer") && !!payment?.settlement_iban);
}

/**
 * Résumé des moyens proposés aux chauffeurs. Centrale : lecture + « Modifier » vers Réglages › Commission &
 * encaissement (une seule source) ; flotte : « Modifier » ouvre la carte « Encaissement » ici.
 */
function PaymentSummary({ payment, action }: { payment: NetworkPaymentRow | null; action: React.ReactNode }) {
  const methods = payment?.settlement_methods ?? [];
  const ready: Record<SettlementMethod, boolean> = {
    link: !!payment?.settlement_link,
    transfer: !!payment?.settlement_iban,
    cash: true,
    other: !!payment?.settlement_instructions,
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white/[0.02] px-4 py-3">
      <div className="flex flex-wrap gap-1.5">
        {methods.length === 0 ? (
          <span className="text-[12.5px] text-fg-subtle">Aucun moyen de paiement renseigné.</span>
        ) : (
          methods.map((m) => {
            const Icon = METHOD_ICON[m];
            return (
              <span key={m} className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12.5px]", ready[m] ? "border-line-strong text-fg" : "border-amber/40 text-amber")}>
                <Icon className="size-3.5" /> {methodLabel(m)}
                {!ready[m] && " — à renseigner"}
              </span>
            );
          })
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * Flotte : résumé + « Modifier », ou carte « Encaissement » ouverte — d'office seulement quand le partage est demandé
 * sans moyen en ligne, ou en arrivant par le lien d'action (#encaissement) ; toujours refermable (« Annuler »). Une
 * flotte qui ne fait que recevoir garde une carte courte.
 */
function FleetPayment(p: Props) {
  const needed = p.canManage && !!p.membership?.share_out && !hasOnlineMethod(p.payment);
  const [editing, setEditing] = useState(needed);
  // Partage activé (ou dernier moyen en ligne retiré) depuis l'ouverture de la page : carte ouverte
  useEffect(() => {
    if (needed) setEditing(true);
  }, [needed]);
  useEffect(() => {
    if (!p.canManage) return;
    const sync = () => window.location.hash === `#${SETTINGS_ANCHORS.payment}` && setEditing(true);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [p.canManage]);
  if (!editing) {
    return (
      <PaymentSummary
        payment={p.payment}
        action={
          p.canManage ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Settings2 /> Modifier
            </Button>
          ) : null
        }
      />
    );
  }
  return <NetworkPaymentMethodsForm {...p} onDone={() => setEditing(false)} />;
}

/** Flotte : carte « Encaissement » (bloc partagé avec « Commission & encaissement »), éditable ici. */
function NetworkPaymentMethodsForm(p: Props & { onDone?: () => void }) {
  const router = useRouter();
  const initial = useMemo<SettlementMethodsValue>(
    () =>
      settlementMethodsFromRow(
        p.payment ?? { settlement_methods: null, settlement_link: null, settlement_instructions: null, settlement_payee_name: null, settlement_iban: null, settlement_bic: null },
      ),
    [p.payment],
  );
  const [baseline, setBaseline] = useState(initial);
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, run } = useNetworkRunner();
  const dirty = JSON.stringify(f) !== JSON.stringify(baseline);
  // Relecture de la page (temps réel, autre onglet) : valeurs du serveur reprises, jamais par-dessus une saisie en cours
  const initialKey = JSON.stringify(initial);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setBaseline(initial);
    setF(initial);
    // Dépendance sur la valeur (initialKey) et non sur l'objet, recréé à chaque relecture
  }, [initialKey]);
  const set = <K extends keyof SettlementMethodsValue>(k: K, v: SettlementMethodsValue[K]) => {
    setF((cur) => ({ ...cur, [k]: v }));
    setErrors(({ [k]: _drop, ...rest }) => rest);
  };
  const save = () => {
    const parsed = settlementPaymentSchema.safeParse(f);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return void toast.error(describeError(parsed.error, PAYMENT_LABELS));
    }
    run(
      async () => {
        const res = await updateNetworkPaymentMethods(f);
        if (!res.ok && res.fieldErrors) setErrors(res.fieldErrors);
        return res;
      },
      () => {
        setBaseline(f);
        router.refresh();
        p.onDone?.();
      },
    );
  };
  return (
    <form onSubmit={submitWith(save)} className="space-y-4">
      <SettlementMethodsFields
        value={f}
        onChange={set}
        errors={errors}
        readOnly={!p.canManage}
        orgName={p.orgName}
        legalName={p.legalName}
        currency={p.currency}
        audience="Le chauffeur partenaire"
        whatsapp={false}
      />
      {p.canManage && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {(dirty || p.onDone) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setF(baseline);
                setErrors({});
                p.onDone?.();
              }}
              disabled={pending}
            >
              Annuler
            </Button>
          )}
          <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!dirty}>
            Enregistrer
          </Button>
        </div>
      )}
    </form>
  );
}

const PAYMENT_LABELS: Record<string, string> = {
  methods: "Moyens acceptés",
  link: "Lien de paiement",
  instructions: "Instructions",
  payeeName: "Bénéficiaire",
  iban: "IBAN",
  bic: "BIC",
};

// ---------------------------------------------------------------------------- Recevoir les courses du réseau
function ReceiveCard(p: Props & { pending: boolean; onToggle: (on: boolean) => void }) {
  const on = !!p.membership?.share_in;
  const { pending, run } = useNetworkRunner();
  const insured = !!p.membership?.insurance_confirmed_at;
  const drivers = p.drivers ?? [];
  const readyCount = drivers.filter((d) => driverReadinessView(d.readiness, d.driver.id, p.timeZone).ready).length;
  // Réception demandée mais pas encore active (validation Rydar, convention, assurance…) : dit une fois, ici
  const waiting = on && !!p.readiness && !p.readiness.share_in.active;
  const copy = RECEIVE_COPY[p.model];
  return (
    <Card id={SETTINGS_ANCHORS.receive} className="scroll-mt-6">
      <SwitchHeader
        id="recevoir"
        icon={<ArrowDownLeft />}
        title="Recevoir les courses du réseau"
        description={copy.description}
        checked={on}
        disabled={!p.canManage || p.pending}
        onToggle={p.onToggle}
        status={sideStatus(p.readiness, "in", on)}
      />
      <CardBody className="space-y-5">
        <label className={cn("flex items-start gap-3 rounded-xl border px-4 py-3", insured ? "border-line bg-white/[0.02]" : "border-amber/30 bg-amber/[0.04]")}>
          <input
            type="checkbox"
            checked={insured}
            disabled={!p.canManage || pending}
            onChange={(e) => run(() => setNetworkInsurance(e.target.checked))}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]"
          />
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium">{copy.insurance}</span>
            <span className="block text-[12px] text-fg-subtle">
              {insured && p.membership?.insurance_confirmed_at
                ? `Confirmé le ${formatDate(p.membership.insurance_confirmed_at, p.timeZone)}.`
                : copy.insuranceHint}
            </span>
          </span>
        </label>

        <section aria-labelledby="chauffeurs-title" className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 id="chauffeurs-title" className="flex items-center gap-2 text-[13.5px] font-semibold">
                <Users className="size-4 text-fg-subtle" /> Vos chauffeurs
              </h3>
              <p className="mt-0.5 text-[12.5px] text-fg-muted">
                Chaque chauffeur active lui-même « Courses du réseau partagé » dans son application et règle lui-même avec
                l&apos;organisation qui lui confie la course.
                {p.model === "centrale" &&
                  " Pour un chauffeur indépendant, renseignez son n° d'inscription au registre des exploitants VTC : il figure sur le bon de réservation."}
              </p>
            </div>
            {on && p.drivers && drivers.length > 0 && (
              <p className="text-[12.5px] text-fg-subtle">
                <span className="font-semibold text-fg">{readyCount}</span> prêt{readyCount > 1 ? "s" : ""} sur {drivers.length}
              </p>
            )}
          </div>
          {!on ? (
            // Réception désactivée : pas de liste de manques (ni de bouton qui ramènerait ici)
            <p className="text-[12.5px] text-fg-subtle">Activez la réception pour voir quels chauffeurs sont prêts.</p>
          ) : !p.canManage ? (
            <p className="text-[12.5px] text-fg-subtle">Liste réservée au propriétaire et aux administrateurs.</p>
          ) : p.driversFailed ? (
            <p className="text-[12.5px] text-red">Liste des chauffeurs indisponible. Réessayez dans un instant.</p>
          ) : drivers.length === 0 ? (
            <p className="text-[12.5px] text-fg-subtle">Aucun chauffeur actif.</p>
          ) : (
            <>
              {waiting && (
                <p className="text-[12.5px] text-fg-muted">
                  La réception n&apos;est pas encore active{NB}: les chauffeurs prêts recevront les courses dès qu&apos;elle le sera.
                </p>
              )}
              <ul className="divide-y divide-line rounded-xl border border-line">
                {drivers.map((d) => (
                  <DriverRow key={d.driver.id} d={d} model={p.model} timeZone={p.timeZone} />
                ))}
              </ul>
            </>
          )}
        </section>
      </CardBody>
    </Card>
  );
}

function DriverRow({ d, model, timeZone }: { d: OrgNetworkDriver; model: DispatchModel; timeZone: string }) {
  const { pending, run } = useNetworkRunner();
  const view = driverReadinessView(d.readiness, d.driver.id, timeZone);
  const allowed = d.settings?.org_allowed ?? true;
  const name = `${d.driver.first_name} ${d.driver.last_name}`;
  const [opError, setOpError] = useState<string | null>(null);
  const [editingOp, setEditingOp] = useState(!d.vtc_operator_registration);
  const saveOperator = (value: string) =>
    run(
      async () => {
        const res = await setDriverOperatorRegistration(d.driver.id, value);
        setOpError(res.ok ? null : (res.fieldErrors?.value ?? res.error));
        return res;
      },
      () => setEditingOp(!value.trim()),
    );
  return (
    <li className="px-4 py-3">
      {/* Largeur minimale du nom : sur téléphone, l'action et « Autorisé » passent dessous au lieu d'écraser le texte */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-[220px] flex-1 items-start gap-3">
          <Avatar name={name} size={30} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium">
              <Link href={`/dashboard/drivers/${d.driver.id}`} prefetch={false} className="hover:text-brand">{name}</Link>{" "}
              <span className="mono font-normal text-fg-subtle">#{d.driver.number}</span>
            </p>
            {/* Tous les manques en clair (lisibles au doigt et au clavier), sur plusieurs lignes si besoin */}
            <p className={cn("text-[12px]", view.ready ? "text-green" : "text-amber")}>{view.text}</p>
          </div>
        </div>
        {view.action && (
          <Button asChild variant="ghost" size="xs">
            <Link href={view.action.href} prefetch={false}>{view.action.label}</Link>
          </Button>
        )}
        <label className="flex items-center gap-2 text-[12.5px] text-fg-muted">
          Autorisé
          <Switch checked={allowed} disabled={pending} onCheckedChange={(v) => run(() => setDriverNetworkAllowed(d.driver.id, v))} aria-label={`Autoriser ${name} à recevoir les courses du réseau`} />
        </label>
      </div>
      {/* Centrale : n° d'exploitant VTC du chauffeur indépendant (champ « exploitant » du bon de réservation) */}
      {model === "centrale" &&
        (d.vtc_operator_registration && !editingOp ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 pl-[42px] text-[12px] text-fg-muted">
            N° d&apos;exploitant VTC <span className="mono text-fg">{d.vtc_operator_registration}</span>
            <Button variant="ghost" size="xs" onClick={() => setEditingOp(true)}>Modifier</Button>
          </p>
        ) : (
          <form
            className="mt-2 flex flex-wrap items-start gap-2 pl-[42px]"
            onSubmit={submitWith((data) => saveOperator(String(data.get("operator") ?? "")))}
          >
            <Field className="min-w-[220px] flex-1" error={opError ?? undefined}>
              <Input
                name="operator"
                defaultValue={d.vtc_operator_registration ?? ""}
                maxLength={80}
                placeholder="N° d'exploitant VTC (EVTC…)"
                aria-label={`N° d'exploitant VTC de ${name}`}
                className="mono h-9 text-[13px]"
                aria-invalid={!!opError}
              />
            </Field>
            <Button type="submit" variant="secondary" size="sm" loading={pending}>Enregistrer</Button>
          </form>
        ))}
    </li>
  );
}

// ---------------------------------------------------------------------------- Options avancées
function AdvancedOptions(p: Props & { showTerms: boolean }) {
  const [open, setOpen] = useState(false);
  // Lien d'action vers une option (#convention, #options) : section dépliée
  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.slice(1);
      if (h === SETTINGS_ANCHORS.advanced || (p.showTerms && h === SETTINGS_ANCHORS.terms)) setOpen(true);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [p.showTerms]);
  return (
    <details
      id={SETTINGS_ANCHORS.advanced}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="surface scroll-mt-6 rounded-xl"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block text-[14px] font-semibold tracking-tight">Options avancées</span>
          <span className="block text-[12.5px] text-fg-muted">Plafond par chauffeur, organisations et chauffeurs exclus, convention.</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />
      </summary>
      <div className="space-y-6 border-t border-line px-5 py-5">
        <CreditLimitForm {...p} />
        <PartnerExclusions {...p} />
        <DriverExclusions {...p} />
        {p.showTerms && (
          <TermsCard canManage={p.canManage} version={p.termsVersion} readiness={p.readiness} acceptedBy={p.termsAcceptedBy} timeZone={p.timeZone} />
        )}
      </div>
    </details>
  );
}

function CreditLimitForm(p: Props) {
  const cents = p.membership?.executor_credit_limit_cents ?? NETWORK_PARAMS.executorCreditLimitDefaultCents;
  const { pending, run } = useNetworkRunner();
  const [error, setError] = useState<string | null>(null);
  const save = (amount: string) =>
    run(async () => {
      const res = await setExecutorCreditLimit({ amount });
      setError(res.ok ? null : (res.fieldErrors?.amount ?? res.error));
      return res;
    });
  return (
    <section aria-labelledby="plafond-title" className="space-y-2">
      <h3 id="plafond-title" className="text-[13.5px] font-semibold">Plafond par chauffeur</h3>
      <p className="text-[12.5px] text-fg-muted">
        Total que chacun de vos chauffeurs peut devoir aux organisations partenaires. Au-delà, il ne reçoit plus leurs courses
        jusqu&apos;au règlement. Actuellement&nbsp;: <span className="mono text-fg">{formatPrice(cents, p.currency)}</span>.
      </p>
      <form className="flex flex-wrap items-start gap-2" onSubmit={submitWith((data) => save(String(data.get("amount") ?? "")))}>
        <Field className="w-[160px]" error={error ?? undefined}>
          <div className="relative">
            <Input
              name="amount"
              inputMode="decimal"
              defaultValue={String(cents / 100).replace(".", ",")}
              disabled={!p.canManage}
              aria-label="Plafond par chauffeur en euros"
              aria-invalid={!!error}
              className="mono h-9 pr-8 text-[13px]"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-fg-subtle">€</span>
          </div>
        </Field>
        {p.canManage && <Button type="submit" variant="secondary" size="sm" loading={pending}>Enregistrer</Button>}
      </form>
    </section>
  );
}

function PartnerExclusions(p: Props) {
  const { pending, run } = useNetworkRunner();
  const excluded = new Set(p.excludedPartners);
  // « Exclure » : même fenêtre de confirmation que depuis une course (effet dans les deux sens, partenaire non prévenu) ;
  // « Réintégrer » : en un clic (favorable, réversible)
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  return (
    <section aria-labelledby="orgs-title" className="space-y-2">
      <h3 id="orgs-title" className="text-[13.5px] font-semibold">Organisations exclues</h3>
      <p className="text-[12.5px] text-fg-muted">
        Une organisation exclue ne reçoit plus vos courses et ne vous confie plus les siennes. Elle n&apos;en est pas informée.
        Seules les organisations déjà rencontrées sont listées.
      </p>
      {p.partners.length === 0 ? (
        <p className="text-[12.5px] text-fg-subtle">Aucune organisation rencontrée pour l&apos;instant.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {p.partners.map((o) => {
            const out = excluded.has(o.id);
            return (
              <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0 truncate text-[13px]">
                  {o.name} {out && <Badge tone="red" className="ml-1.5">Exclue</Badge>}
                </span>
                {p.canManage && (
                  <Button
                    variant={out ? "ghost" : "outline"}
                    size="xs"
                    disabled={pending}
                    onClick={() => (out ? run(() => setNetworkPartnerExcluded(o.id, false)) : setConfirm(o))}
                  >
                    {out ? <><Undo2 /> Réintégrer</> : "Exclure"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirm && <ExcludePartnerDialog partner={confirm} onClose={() => setConfirm(null)} />}
    </section>
  );
}

function DriverExclusions(p: Props) {
  const { pending, run } = useNetworkRunner();
  const list = (p.driverExclusions ?? []).filter((x) => !x.lifted_at);
  return (
    <section aria-labelledby="exclus-title" className="space-y-2">
      <h3 id="exclus-title" className="text-[13.5px] font-semibold">Chauffeurs partenaires exclus</h3>
      <p className="text-[12.5px] text-fg-muted">
        Un chauffeur exclu ne reçoit plus vos courses, quelle que soit son organisation. Pour exclure un chauffeur, ouvrez une de ses
        courses dans « Courses confiées ».
      </p>
      {!p.canManage ? (
        <p className="text-[12.5px] text-fg-subtle">Liste réservée au propriétaire et aux administrateurs.</p>
      ) : p.driverExclusions === null ? (
        <p className="text-[12.5px] text-fg-subtle">Liste indisponible pour le moment.</p>
      ) : list.length === 0 ? (
        <p className="text-[12.5px] text-fg-subtle">Aucun chauffeur exclu.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {list.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-[13px]">{x.label}</span>
                <span className="block truncate text-[11.5px] text-fg-subtle">
                  le {formatDate(x.created_at, p.timeZone)}
                  {x.created_by_name ? ` par ${x.created_by_name}` : ""}
                  {x.reason ? ` · « ${x.reason} »` : ""}
                </span>
              </span>
              <Button variant="ghost" size="xs" disabled={pending} onClick={() => run(() => liftNetworkDriverExclusion(x.id))}>
                <Undo2 /> Lever
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- convention
function TermsCard({
  canManage, version, readiness, acceptedBy, timeZone, prominent,
}: {
  canManage: boolean;
  version: string;
  readiness: OrgNetworkReadiness | null;
  acceptedBy: string | null;
  timeZone: string;
  prominent?: boolean;
}) {
  const { pending, run } = useNetworkRunner();
  const [checked, setChecked] = useState(false);
  const t = readiness?.terms;
  const current = t?.accepted_version === version;
  const grace = t?.grace_until && t.accepted_version && t.accepted_version === t.min_version ? formatDate(t.grace_until, timeZone) : null;
  const body = (
    <div className="space-y-3">
      <p className="text-[12.5px] text-fg-muted">
        Version en vigueur <span className="mono text-fg">{version}</span>
        {t?.accepted_version
          ? ` · version ${t.accepted_version} acceptée${t.accepted_at ? ` le ${formatDate(t.accepted_at, timeZone)}` : ""}${acceptedBy ? ` par ${acceptedBy}` : ""}`
          : " · pas encore acceptée"}
        .
      </p>
      {!current && grace && <p className="text-[12.5px] text-amber">Nouvelle version à accepter avant le {grace}{NB}: l&apos;ancienne reste valable jusque-là.</p>}
      <a href={NETWORK_DOCUMENTS.network.path} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-[13px] text-brand hover:underline">
        Lire la convention <ExternalLink className="size-3.5" />
      </a>
      {!current && canManage && (
        <form
          className="flex flex-wrap items-center gap-3"
          onSubmit={submitWith(() => checked && run(() => acceptNetworkTerms(version)))}
        >
          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-fg-muted">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]" />
            <span>J&apos;accepte la convention du réseau partagé (version {version}) au nom de mon organisation.</span>
          </label>
          <Button type="submit" variant="primary" size="sm" disabled={!checked} loading={pending}>
            Accepter
          </Button>
        </form>
      )}
    </div>
  );
  if (!prominent) {
    return (
      <section id={SETTINGS_ANCHORS.terms} aria-labelledby="convention-title" className="scroll-mt-6 space-y-2">
        <h3 id="convention-title" className="text-[13.5px] font-semibold">Convention</h3>
        {body}
      </section>
    );
  }
  return (
    <Card id={SETTINGS_ANCHORS.terms} className="scroll-mt-6 border-blue/30">
      <CardHeader icon={<FileCheck2 />} title="Nouvelle convention du réseau partagé" description="Le propriétaire ou un administrateur l'accepte au nom de l'organisation." />
      <CardBody>{body}</CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------- première activation
function ActivateDialog({
  side, version, approval, model, graceHours, onClose,
}: {
  side: "out" | "in" | null;
  version: string;
  approval: string;
  model: DispatchModel;
  graceHours: number;
  onClose: () => void;
}) {
  const { pending, run } = useNetworkRunner();
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (side) setChecked(false);
  }, [side]);
  const copy = activateCopy(side ?? "out", model, graceHours);
  return (
    <Dialog open={!!side} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md" title={copy.title} description="Le réseau partagé est une option du logiciel de dispatch, régie par une convention entre organisations.">
        <form onSubmit={submitWith(() => side && checked && run(() => setNetworkSharing({ side, enabled: true, termsVersion: version }), onClose))}>
          <ul className="space-y-2">
            {copy.points.map((t) => (
              <li key={t} className="flex gap-2.5 text-[13px] leading-relaxed text-fg-muted">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-violet" />
                {t}
              </li>
            ))}
          </ul>
          {approval !== "approved" && (
            <p className="mt-4 flex items-start gap-2 rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[12.5px] text-fg-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
              Avant l&apos;ouverture, Rydar vérifie votre inscription au registre des exploitants VTC (vérification administrative).
            </p>
          )}
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13px] text-fg">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]" />
            <span>
              J&apos;accepte la{" "}
              <a href={NETWORK_DOCUMENTS.network.path} target="_blank" rel="noopener" className="text-brand underline underline-offset-2">
                convention du réseau partagé
              </a>{" "}
              (version {version}) au nom de mon organisation.
            </span>
          </label>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
            <Button type="submit" variant="primary" disabled={!checked} loading={pending}>
              Activer
            </Button>
          </div>
        </form>
        <p className="mt-4 flex items-start gap-2 text-[11.5px] text-fg-subtle">
          <Info className="mt-0.5 size-3.5 shrink-0" /> Vous pouvez désactiver à tout moment : les courses déjà acceptées vont à leur terme.
        </p>
      </DialogContent>
    </Dialog>
  );
}

