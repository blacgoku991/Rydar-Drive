import { ORG_STATUS_META, formatNumber } from "@rydar/shared";
import { Building2, ChevronRight, Radio, UserCog, Users } from "lucide-react";
import Link from "next/link";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ONLINE_PRESENCES, PRESENCE_SHORT, textOn } from "./live-types";
import type { OrgHeadcount, PlatformHeadcount } from "./platform-data";

// Effectifs de la plateforme (vue d'ensemble du super admin) — composants serveur, sans état.

type Row = { label: string; value: number; color?: string; tone?: "brand" | "cyan" | "amber" | "red" | "green" };
const TONE = { brand: "text-brand", cyan: "text-cyan", amber: "text-amber", red: "text-red", green: "text-green" } as const;

function HeadcountCard({ title, value, sub, icon, rows, action }: { title: string; value: number; sub?: string; icon: React.ReactNode; rows: Row[]; action?: React.ReactNode }) {
  return (
    <div className="surface flex flex-col rounded-xl px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] text-fg-muted">{title}</span>
        <span className="text-fg-subtle [&_svg]:size-4">{icon}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[26px] font-semibold leading-none tracking-tight tabular-nums">{formatNumber(value)}</span>
        {sub && <span className="text-[12px] text-fg-muted">{sub}</span>}
      </div>
      <dl className="mt-3 space-y-1.5 border-t border-line pt-3">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 text-[12.5px]">
            <dt className="flex min-w-0 items-center gap-2 text-fg-muted">
              {r.color && <span className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />}
              <span className="truncate">{r.label}</span>
            </dt>
            <dd className={cn("tabular-nums", r.value > 0 && r.tone ? TONE[r.tone] : r.value > 0 ? "text-fg" : "text-fg-subtle")}>{formatNumber(r.value)}</dd>
          </div>
        ))}
      </dl>
      {action && <div className="mt-auto pt-3">{action}</div>}
    </div>
  );
}

/** Quatre cartes : organisations, chauffeurs, membres des tableaux de bord, en ligne maintenant. */
export function HeadcountCards({ hc }: { hc: PlatformHeadcount }) {
  const { orgs, drivers, members } = hc;
  const online = drivers.online;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <HeadcountCard
        title="Organisations"
        value={orgs.total}
        sub={`${orgs.active} active${orgs.active > 1 ? "s" : ""}`}
        icon={<Building2 />}
        rows={[
          { label: "Flottes", value: orgs.fleet },
          { label: "Centrales à commission", value: orgs.centrale },
          { label: "Actives", value: orgs.active, tone: "green" },
          { label: "Suspendues", value: orgs.suspended, tone: "amber" },
        ]}
      />
      <HeadcountCard
        title="Chauffeurs actifs"
        value={drivers.active}
        sub="toutes organisations"
        icon={<Users />}
        rows={[
          { label: "En ligne maintenant", value: drivers.online, tone: "brand" },
          { label: "Occupés (course acceptée)", value: drivers.busy, tone: "cyan" },
          { label: "Candidatures en attente", value: drivers.applications, tone: "amber" },
          { label: "Bannis", value: drivers.banned, tone: "red" },
        ]}
      />
      <HeadcountCard
        title="Membres des tableaux de bord"
        value={members.active}
        sub={members.invited ? `+ ${members.invited} invité${members.invited > 1 ? "s" : ""}` : "actifs"}
        icon={<UserCog />}
        rows={[
          { label: "Propriétaires", value: members.byRole.owner },
          { label: "Administrateurs", value: members.byRole.admin },
          { label: "Dispatchers", value: members.byRole.dispatcher },
          { label: "Super admins (Rydar)", value: hc.superAdmins },
        ]}
      />
      <div className="surface flex flex-col rounded-xl px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] text-fg-muted">En ligne maintenant</span>
          <Radio className="size-4 text-fg-subtle" />
        </div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className={cn("text-[26px] font-semibold leading-none tracking-tight tabular-nums", online > 0 && "text-brand")}>{formatNumber(online)}</span>
          <span className="text-[12px] text-fg-muted">sur {formatNumber(drivers.active)} actifs</span>
        </div>
        {/* Répartition par statut */}
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-white/[0.05]" role="img" aria-label="Répartition des chauffeurs en ligne par statut">
          {ONLINE_PRESENCES.map((p) =>
            drivers.byPresence[p] ? <span key={p} style={{ width: `${(drivers.byPresence[p] / Math.max(1, online)) * 100}%`, background: PRESENCE_COLOR[p] }} /> : null,
          )}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
          {ONLINE_PRESENCES.map((p) => (
            <div key={p} className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-2 text-fg-muted">
                <span className="size-2 rounded-full" style={{ background: PRESENCE_COLOR[p] }} />
                {PRESENCE_SHORT[p]}
              </dt>
              <dd className={cn("tabular-nums", drivers.byPresence[p] ? "text-fg" : "text-fg-subtle")}>{drivers.byPresence[p]}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-auto pt-3">
          <Link href="/admin/carte" className="inline-flex h-8 items-center gap-1 text-[12.5px] font-medium text-brand hover:underline">
            Voir sur la carte en direct <ChevronRight className="size-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function Swatch({ org }: { org: Pick<OrgHeadcount, "color" | "code"> }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg text-[11px] font-bold" style={{ background: org.color, color: textOn(org.color) }} aria-hidden>
      {org.code}
    </span>
  );
}

const num = (n: number, tone?: string) => <span className={cn("num", n > 0 ? tone ?? "text-fg" : "text-fg-subtle")}>{formatNumber(n)}</span>;

/** Tableau « Effectifs par organisation », trié par chauffeurs en ligne. */
export function OrgHeadcountTable({ rows }: { rows: OrgHeadcount[] }) {
  const sorted = [...rows].sort(
    (a, b) => b.drivers_online - a.drivers_online || b.drivers_active - a.drivers_active || b.rides_today - a.rides_today || a.name.localeCompare(b.name, "fr"),
  );
  const total = sorted.reduce(
    (t, r) => ({
      members: t.members + r.members,
      active: t.active + r.drivers_active,
      online: t.online + r.drivers_online,
      busy: t.busy + r.drivers_busy,
      applications: t.applications + r.applications,
      rides: t.rides + r.rides_today,
    }),
    { members: 0, active: 0, online: 0, busy: 0, applications: 0, rides: 0 },
  );
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Effectifs par organisation"
        description="Membres des tableaux de bord et chauffeurs de chaque flotte ou centrale, triés par chauffeurs en ligne. Occupés : en route, sur place ou en course."
        action={
          <Link href="/admin/carte" className="text-[12.5px] text-brand hover:underline">
            Carte en direct
          </Link>
        }
      />
      <Table>
        <THead>
          <tr>
            <TH>Organisation</TH>
            <TH>Modèle</TH>
            <TH>Statut</TH>
            <TH className="text-right">Membres</TH>
            <TH className="text-right">Chauffeurs actifs</TH>
            <TH className="text-right">En ligne</TH>
            <TH className="text-right">Occupés</TH>
            <TH className="text-right">Candidatures</TH>
            <TH className="text-right">Courses auj.</TH>
          </tr>
        </THead>
        <tbody>
          {sorted.map((o) => (
            <TR key={o.id} className="relative">
              <TD>
                <Link href={`/admin/organizations/${o.id}`} className="absolute inset-0" aria-label={o.name} />
                <span className="flex items-center gap-3">
                  <Swatch org={o} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-medium">{o.name}</span>
                    <span className="block text-[12px] text-fg-muted">{o.city ?? o.slug}</span>
                  </span>
                </span>
              </TD>
              <TD>
                <Badge tone={o.dispatch_model === "centrale" ? "violet" : "neutral"} dot={false}>
                  {o.dispatch_model === "centrale" ? "Centrale" : "Flotte"}
                </Badge>
              </TD>
              <TD>
                <Badge tone={ORG_STATUS_META[o.status].tone}>{ORG_STATUS_META[o.status].label}</Badge>
              </TD>
              <TD className="text-right">{num(o.members)}</TD>
              <TD className="text-right">{num(o.drivers_active)}</TD>
              <TD className="text-right">
                {o.drivers_online > 0 ? (
                  <Link
                    href={`/admin/carte?org=${o.id}`}
                    className="relative z-10 inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 font-medium text-brand hover:bg-brand/10"
                    title="Voir ses chauffeurs sur la carte en direct"
                    aria-label={`${formatNumber(o.drivers_online)} en ligne : voir ses chauffeurs sur la carte en direct`}
                  >
                    <span className="num">{formatNumber(o.drivers_online)}</span>
                  </Link>
                ) : (
                  num(0)
                )}
              </TD>
              <TD className="text-right">{num(o.drivers_busy, "text-cyan")}</TD>
              <TD className="text-right">{num(o.applications, "text-amber")}</TD>
              <TD className="text-right">{num(o.rides_today)}</TD>
            </TR>
          ))}
          {!sorted.length && (
            <tr>
              <td colSpan={9} className="px-5 py-8 text-center text-[13px] text-fg-muted">
                Aucune organisation.
              </td>
            </tr>
          )}
        </tbody>
        {sorted.length > 1 && (
          <tfoot className="border-t border-line bg-white/[0.02]">
            <tr>
              <TD className="h-11 text-[12.5px] font-medium text-fg-muted" colSpan={3}>
                Total · {sorted.length} organisations
              </TD>
              <TD className="h-11 text-right">{num(total.members)}</TD>
              <TD className="h-11 text-right">{num(total.active)}</TD>
              <TD className="h-11 text-right">{num(total.online, "text-brand")}</TD>
              <TD className="h-11 text-right">{num(total.busy, "text-cyan")}</TD>
              <TD className="h-11 text-right">{num(total.applications, "text-amber")}</TD>
              <TD className="h-11 text-right">{num(total.rides)}</TD>
            </tr>
          </tfoot>
        )}
      </Table>
    </Card>
  );
}
