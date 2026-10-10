"use client";
// Pages Réseau / Inscriptions : chauffeurs bannis définitivement (identités refusées), déblocage d'une identité
// (confirmation) et levée d'un bannissement. Textes selon le modèle (orgWords : « Banni de votre flotte »).
import { IDENTITY_KIND_LABELS, formatDate, type DispatchModel, type FraudReport, type IdentityKind } from "@rydar/shared";
import { Globe2, ShieldBan, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { liftIdentityBan } from "@/app/dashboard/network/actions";
import { LiftBanButton } from "@/components/network/driver-safety";
import { IDENTITY_ORDER, REPORT_STATUS_FOR_ORG, fullName } from "@/components/network/labels";
import { Badge, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
import { orgWords } from "@/lib/wording";

const NB = " ";

export type BannedIdentityChip = { id: string; kind: IdentityKind; hint: string | null };
export type BannedDriverRow = {
  id: string;
  number: number;
  first_name: string;
  last_name: string;
  phone: string;
  photo_url: string | null;
  banned_at: string;
  ban_reason: string | null;
  ban_scope: "org" | "platform" | null;
  banned_by_name: string | null;
  identities: BannedIdentityChip[];
  report_status: FraudReport["status"] | null;
};

export function BannedDriversCard({
  drivers,
  canManage,
  timeZone,
  model,
}: {
  drivers: BannedDriverRow[];
  canManage: boolean;
  timeZone: string;
  /** Modèle de l'organisation : « votre flotte » / « votre centrale » */
  model: DispatchModel;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [unblock, setUnblock] = useState<(BannedIdentityChip & { driver: string }) | null>(null);
  const w = orgWords(model);

  const doUnblock = () =>
    start(() => runAction(async () => {
      if (!unblock) return;
      const res = await liftIdentityBan(unblock.id);
      if (!res.ok) return void toast.error(res.error);
      const feminine = unblock.kind === "plate" || unblock.kind === "identity_doc" || unblock.kind === "vtc_card";
      toast.success(`${IDENTITY_KIND_LABELS[unblock.kind]} débloqué${feminine ? "e" : ""}`, { description: res.message });
      setUnblock(null);
      router.refresh();
    }));

  if (!drivers.length) {
    return (
      <Card>
        <EmptyState
          size="compact"
          icon={<ShieldBan />}
          title="Aucun chauffeur banni."
          description={`Pour bannir un fraudeur${NB}: sa fiche → «${NB}Bannir définitivement${NB}».`}
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Chauffeurs bannis · ${drivers.length}`}
        icon={<ShieldBan />}
        description="Bannissement définitif : téléphone, e-mail, carte VTC, permis, pièce d'identité et appareils refusés à toute nouvelle inscription."
      />
      <ul className="divide-y divide-line">
        {drivers.map((d) => {
          const platform = d.ban_scope === "platform";
          const ids = [...d.identities].sort((a, b) => IDENTITY_ORDER.indexOf(a.kind) - IDENTITY_ORDER.indexOf(b.kind));
          const report = d.report_status ? REPORT_STATUS_FOR_ORG[d.report_status] : null;
          return (
            <li key={d.id} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
              <div className="flex min-w-0 gap-3.5">
                <Avatar name={fullName(d)} src={d.photo_url} size={40} className="grayscale" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-semibold">{fullName(d)}</p>
                    <span className="num text-[12px] text-fg-muted">#{d.number}</span>
                    {platform ? (
                      <Badge tone="red">
                        <Globe2 aria-hidden className="size-3" /> Banni par la plateforme Rydar
                      </Badge>
                    ) : (
                      <Badge tone="red">Banni de {w.your}</Badge>
                    )}
                  </div>
                  {/* Téléphone : seulement dans les identités refusées (masqué), jamais répété en clair */}
                  <p className="text-[13px] text-fg-muted">
                    Banni le <span className="num">{formatDate(d.banned_at, timeZone)}</span>
                    {d.banned_by_name && !platform ? ` par ${d.banned_by_name}` : ""}
                  </p>
                  {d.ban_reason && <p className="text-[13px] leading-relaxed text-fg">Motif{NB}: {d.ban_reason}</p>}
                  {ids.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5 pt-0.5" aria-label="Identités refusées">
                      {ids.map((i) => (
                        <li key={i.id} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-red/20 bg-red/[0.05] py-0.5 pl-2 pr-1 text-[12px]">
                          <span className="text-fg-muted">{IDENTITY_KIND_LABELS[i.kind]}</span>
                          <span className="num font-medium text-fg">{i.hint ?? "••••"}</span>
                          {canManage && (
                            <button
                              type="button"
                              onClick={() => setUnblock({ ...i, driver: fullName(d) })}
                              className="ml-0.5 inline-flex min-h-7 items-center rounded px-1.5 text-[12px] font-medium text-fg-muted underline-offset-2 hover:bg-white/10 hover:text-fg hover:underline"
                              aria-label={`Débloquer${NB}: ${IDENTITY_KIND_LABELS[i.kind]} ${i.hint ?? ""}`.trim()}
                            >
                              Débloquer
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {report && (
                    <p className="text-[12px] text-fg-muted">
                      Signalement Rydar{NB}: <span className={report.tone === "neutral" ? "text-fg" : toneText[report.tone]}>{report.label}</span>
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:pl-[54px]">
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/dashboard/drivers/${d.id}`} prefetch={false}>
                    <UserRound /> Fiche
                  </Link>
                </Button>
                {canManage && !platform && <LiftBanButton driverId={d.id} driverName={fullName(d)} model={model} />}
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog open={!!unblock} onOpenChange={(o) => !o && !pending && setUnblock(null)}>
        <DialogContent
          title={`Débloquer cette identité${NB}?`}
          description={unblock ? `${IDENTITY_KIND_LABELS[unblock.kind]} ${unblock.hint ?? ""} de ${unblock.driver} : elle pourra de nouveau être utilisée dans ${w.your}.` : undefined}
        >
          <p className="text-[13px] text-fg-muted">Utile par exemple pour la plaque d&apos;une voiture de location reprise par un autre chauffeur. Le chauffeur reste banni.</p>
          <DialogFooter backDisabled={pending}>
            <Button variant="primary" loading={pending} onClick={doUnblock}>
              Débloquer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
