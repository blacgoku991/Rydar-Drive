"use client";
// Page Réseau : chauffeurs bannis définitivement (identités refusées) et levée d'un bannissement.
import { IDENTITY_KIND_LABELS, formatDate, formatPhone, type FraudReport, type IdentityKind } from "@rydar/shared";
import { Globe2, ShieldBan, ShieldCheck, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { liftIdentityBan } from "@/app/dashboard/network/actions";
import { LiftBanButton } from "@/components/network/driver-safety";
import { IDENTITY_ORDER, REPORT_STATUS_FOR_ORG, fullName } from "@/components/network/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Avatar, EmptyState } from "@/components/ui/misc";

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

export function BannedDriversCard({ drivers, canManage, timeZone }: { drivers: BannedDriverRow[]; canManage: boolean; timeZone: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [unblock, setUnblock] = useState<(BannedIdentityChip & { driver: string }) | null>(null);

  const doUnblock = () =>
    start(async () => {
      if (!unblock) return;
      const res = await liftIdentityBan(unblock.id);
      if (!res.ok) return void toast.error(res.error);
      const feminine = unblock.kind === "plate" || unblock.kind === "identity_doc" || unblock.kind === "vtc_card";
      toast.success(`${IDENTITY_KIND_LABELS[unblock.kind]} débloqué${feminine ? "e" : ""}`, { description: res.message });
      setUnblock(null);
      router.refresh();
    });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Chauffeurs bannis"
        icon={<ShieldBan />}
        description="Bannissement définitif : téléphone, e-mail, carte VTC, permis, pièce d'identité et appareils refusés à toute nouvelle inscription."
        action={drivers.length ? <Badge tone="red" dot={false}>{drivers.length}</Badge> : undefined}
      />
      {!drivers.length ? (
        <EmptyState icon={<ShieldCheck />} title="Aucun chauffeur banni" description="Bannissez un fraudeur depuis sa fiche (« Bannir définitivement ») : il ne pourra plus revenir, même avec un nouveau compte." />
      ) : (
        <ul className="divide-y divide-line">
          {drivers.map((d) => {
            const platform = d.ban_scope === "platform";
            const ids = [...d.identities].sort((a, b) => IDENTITY_ORDER.indexOf(a.kind) - IDENTITY_ORDER.indexOf(b.kind));
            const report = d.report_status ? REPORT_STATUS_FOR_ORG[d.report_status] : null;
            return (
              <li key={d.id} className="flex flex-col gap-3 px-5 py-4">
                <div className="flex min-w-0 gap-3.5">
                  <Avatar name={fullName(d)} src={d.photo_url} size={40} className="grayscale" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-semibold">{fullName(d)}</p>
                      <span className="num text-[11.5px] text-fg-subtle">#{d.number}</span>
                      {platform ? (
                        <Badge tone="red"><Globe2 className="size-3" /> Banni par la plateforme Rydar</Badge>
                      ) : (
                        <Badge tone="red">Banni de votre centrale</Badge>
                      )}
                    </div>
                    <p className="text-[12.5px] text-fg-muted">
                      Banni le <span className="num">{formatDate(d.banned_at, timeZone)}</span>
                      {d.banned_by_name && !platform ? ` par ${d.banned_by_name}` : ""} · <span className="num">{formatPhone(d.phone)}</span>
                    </p>
                    {d.ban_reason && <p className="text-[12.5px] leading-relaxed text-fg">Motif : {d.ban_reason}</p>}
                    {ids.length > 0 && (
                      <ul className="flex flex-wrap gap-1.5 pt-0.5" aria-label="Identités refusées">
                        {ids.map((i) => (
                          <li key={i.id} className="inline-flex items-center gap-1.5 rounded-md border border-red/20 bg-red/[0.05] py-1 pl-2 pr-1 text-[11.5px]">
                            <span className="text-fg-subtle">{IDENTITY_KIND_LABELS[i.kind]}</span>
                            <span className="num font-medium text-fg">{i.hint ?? "••••"}</span>
                            {canManage ? (
                              <button
                                type="button"
                                onClick={() => setUnblock({ ...i, driver: fullName(d) })}
                                className="grid size-4 place-items-center rounded text-fg-subtle hover:bg-white/10 hover:text-fg"
                                aria-label={`Débloquer : ${IDENTITY_KIND_LABELS[i.kind]}`}
                                title="Débloquer cette identité"
                              >
                                <X className="size-3" />
                              </button>
                            ) : (
                              <span className="w-1" />
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {report && (
                      <p className="text-[12px] text-fg-subtle">
                        Signalement Rydar : <span className={report.tone === "red" ? "text-red" : report.tone === "amber" ? "text-amber" : "text-fg-muted"}>{report.label}</span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:pl-[54px]">
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/dashboard/drivers/${d.id}`}><UserRound /> Fiche</Link>
                  </Button>
                  {canManage && !platform && <LiftBanButton driverId={d.id} driverName={fullName(d)} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!unblock} onOpenChange={(o) => !o && !pending && setUnblock(null)}>
        <DialogContent
          title="Débloquer cette identité ?"
          description={unblock ? `${IDENTITY_KIND_LABELS[unblock.kind]} ${unblock.hint ?? ""} de ${unblock.driver} : elle pourra de nouveau être utilisée dans votre centrale.` : undefined}
        >
          <p className="text-[12.5px] text-fg-muted">Utile par exemple pour la plaque d&apos;une voiture de location reprise par un autre chauffeur. Le chauffeur reste banni.</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={() => setUnblock(null)}>Annuler</Button>
            <Button variant="primary" loading={pending} onClick={doUnblock}>Débloquer</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
