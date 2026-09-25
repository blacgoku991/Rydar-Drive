"use client";
// Fiche chauffeur : niveau de confiance (mode centrale) et bannissement définitif (flotte et centrale).
import { BAN_CATEGORY_META, TRUST_LEVEL_META, banDriverSchema, fieldErrors, type BanCategory, type TrustLevel } from "@rydar/shared";
import { Check, Flag, ShieldBan, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { banDriver, liftDriverBan, setDriverTrustLevel } from "@/app/dashboard/drivers/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function TrustLevelControl({
  driverId,
  value,
  canManage,
  lockedReason,
}: {
  driverId: string;
  value: TrustLevel;
  canManage: boolean;
  /** Niveau figé (chauffeur banni…) : raison affichée à la place du réglage */
  lockedReason?: string | null;
}) {
  const editable = canManage && !lockedReason;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState<TrustLevel>(value);
  const change = (level: TrustLevel) => {
    if (level === current) return;
    const previous = current;
    setCurrent(level);
    start(async () => {
      const res = await setDriverTrustLevel(driverId, level);
      if (!res.ok) {
        setCurrent(previous);
        return void toast.error(res.error);
      }
      toast.success(`Niveau de confiance : ${TRUST_LEVEL_META[level].label}`);
      router.refresh();
    });
  };
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Niveau de confiance" className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-ink-850 p-1">
        {(["new", "trusted"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={current === t}
            disabled={!editable || pending}
            onClick={() => change(t)}
            className={cn(
              "flex h-8 items-center justify-center gap-1.5 rounded-md text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed",
              current === t ? (t === "trusted" ? "bg-green/15 text-green" : "bg-amber/15 text-amber") : "text-fg-muted hover:text-fg disabled:hover:text-fg-muted",
            )}
          >
            {current === t && <Check className="size-3.5" />}
            {TRUST_LEVEL_META[t].label}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-fg-subtle">{TRUST_LEVEL_META[current].description}</p>
      {lockedReason ? (
        <p className="text-[11.5px] text-fg-subtle">{lockedReason}</p>
      ) : (
        !canManage && <p className="text-[11.5px] text-fg-subtle">Modifiable par un administrateur.</p>
      )}
    </div>
  );
}

export function BanDriverButton({ driverId, driverName, plate, className }: { driverId: string; driverName: string; plate: string | null; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<BanCategory>("fraud");
  const [report, setReport] = useState(false);
  const [vehicle, setVehicle] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [blocker, setBlocker] = useState<string | null>(null);

  const reset = () => {
    setReason("");
    setCategory("fraud");
    setReport(false);
    setVehicle(false);
    setErrors({});
    setBlocker(null);
  };

  const submit = () =>
    start(async () => {
      setBlocker(null);
      const input = { reason, category, reportToPlatform: report, banVehicle: vehicle };
      const parsed = banDriverSchema.safeParse(input);
      if (!parsed.success) return void setErrors(fieldErrors(parsed.error));
      setErrors({});
      const res = await banDriver(driverId, input);
      if (!res.ok) {
        if ("fieldErrors" in res && res.fieldErrors) setErrors(res.fieldErrors);
        if ("code" in res && (res.code === "DRIVER_ON_RIDE" || res.code === "ALREADY_BANNED")) setBlocker(res.error);
        if ("code" in res && res.code === "ALREADY_BANNED") router.refresh();
        return void toast.error(res.error);
      }
      const extra = [
        `${res.identities} identité${res.identities > 1 ? "s" : ""} bloquée${res.identities > 1 ? "s" : ""}`,
        res.reassignedRides ? `${res.reassignedRides} course${res.reassignedRides > 1 ? "s" : ""} remise${res.reassignedRides > 1 ? "s" : ""} en recherche` : "aucune course à réattribuer",
        res.reported ? "signalé à Rydar" : null,
      ].filter(Boolean);
      toast.success(`${driverName} est banni définitivement`, { description: `${res.message} ${extra.join(" · ")}.`, duration: 8000 });
      setOpen(false);
      reset();
      router.refresh();
    });

  return (
    <>
      <Button variant="danger" className={className} onClick={() => { reset(); setOpen(true); }}>
        <ShieldBan /> Bannir définitivement
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent
          size="lg"
          title={`Bannir ${driverName} définitivement ?`}
          description="Accès coupé immédiatement. Son téléphone, e-mail, carte VTC, permis, pièce d'identité et appareils sont refusés à toute nouvelle inscription dans votre centrale."
        >
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-[12.5px] font-medium text-fg-muted">Catégorie</p>
              <div role="radiogroup" aria-label="Catégorie" className="flex flex-wrap gap-1.5">
                {(Object.keys(BAN_CATEGORY_META) as BanCategory[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={category === c}
                    onClick={() => setCategory(c)}
                    className={cn("rounded-full border px-3 py-1.5 text-[12.5px]", category === c ? "border-red/50 bg-red/[0.1] text-red" : "border-line text-fg-muted hover:border-line-strong hover:text-fg")}
                  >
                    {BAN_CATEGORY_META[c].label}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Motif" error={errors.reason} hint="Visible par votre équipe et, en cas de signalement, par Rydar.">
              <Textarea
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (errors.reason) setErrors(({ reason: _r, ...rest }) => rest);
                }}
                maxLength={500}
                aria-invalid={!!errors.reason}
                placeholder="Encaisse les courses sans régler la commission, faux documents…"
              />
            </Field>
            <div className="space-y-2">
              <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3.5", report ? "border-red/40 bg-red/[0.06]" : "border-line hover:border-line-strong")}>
                <input type="checkbox" checked={report} onChange={(e) => setReport(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-red)]" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium"><Flag className="size-3.5 text-red" /> Signaler à Rydar (bannissement de toute la plateforme)</span>
                  <span className="mt-0.5 block text-[12px] text-fg-subtle">Rydar examine le signalement et peut refuser ce chauffeur dans toutes les centrales. Seules des empreintes de ses identités sont transmises.</span>
                </span>
              </label>
              <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3.5", vehicle ? "border-red/40 bg-red/[0.06]" : "border-line hover:border-line-strong")}>
                <input type="checkbox" checked={vehicle} onChange={(e) => setVehicle(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-red)]" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">Bannir aussi le véhicule{plate ? <> (plaque <span className="num whitespace-nowrap">{plate}</span>)</> : null}</span>
                  <span className="mt-0.5 block text-[12px] text-fg-subtle">Si la voiture lui appartient. À éviter pour une voiture de location ou partagée.</span>
                </span>
              </label>
            </div>
            <p className="rounded-lg border border-line bg-white/[0.02] px-3 py-2.5 text-[12px] leading-relaxed text-fg-muted">
              Ses courses acceptées mais pas encore commencées sont remises en recherche. Impossible pendant une course avec client à bord.
            </p>
            {blocker && <p className="rounded-lg border border-red/25 bg-red/[0.07] px-3 py-2.5 text-[12.5px] text-red">{blocker}</p>}
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Annuler</Button>
            <Button variant="danger" loading={pending} onClick={submit}>
              <ShieldBan /> Bannir définitivement
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LiftBanButton({ driverId, driverName }: { driverId: string; driverName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const submit = () =>
    start(async () => {
      const res = await liftDriverBan(driverId, reason);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Bannissement de ${driverName} levé`, { description: res.message, duration: 7000 });
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setReason(""); setOpen(true); }}>
        <Undo2 /> Lever le bannissement
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent title={`Lever le bannissement de ${driverName} ?`} description="Ses identités redeviennent acceptées dans votre centrale.">
          <p className="mb-4 text-[12.5px] text-fg-muted">Il reste suspendu : utilisez « Activer » sur sa fiche pour qu&apos;il reçoive de nouveau des courses.</p>
          <Field label="Motif de la levée" optional>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Dette réglée, erreur…" />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Annuler</Button>
            <Button variant="primary" loading={pending} onClick={submit}>
              <Undo2 /> Lever le bannissement
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
