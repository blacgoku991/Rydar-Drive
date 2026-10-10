import { ORG_STATUS_META, formatNumber, formatRelative } from "@rydar/shared";
import { Building2, ChevronRight, Radio, UserCog, Users } from "lucide-react";
import Link from "next/link";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { DesktopTable, ListCard, MobileList, Table, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";
import { ONLINE_PRESENCES, PRESENCE_SHORT } from "./live-types";
import { CLIENT_KIND_META, type ClientActivityRow, type PlatformHeadcount } from "./platform-data";

// Vue d'ensemble du super admin (docs/REFONTE-PANELS.md, R3) — composants serveur, sans état : tableau « Clients »
// (activité et effectifs de chaque client) et « Effectifs détaillés » (repliés par la page).

// Couleur réservée à ce qui demande une action (§ 3.3) : ambre (à faire, suspendu), rouge (blocage) ; le reste est neutre
type Row = { label: string; value: number; color?: string; tone?: "amber" | "red" };
const TONE = { amber: "text-amber", red: "text-red" } as const;

function HeadcountCard({ title, value, sub, icon, rows, action }: { title: string; value: number; sub?: string; icon: React.ReactNode; rows: Row[]; action?: React.ReactNode }) {
  return (
    <div className="surface flex flex-col rounded-xl px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-fg-muted">{title}</span>
        <span aria-hidden className="text-fg-subtle [&_svg]:size-4">{icon}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[26px] font-semibold leading-none tracking-tight tabular-nums">{formatNumber(value)}</span>
        {sub && <span className="text-[12.5px] text-fg-muted">{sub}</span>}
      </div>
      <dl className="mt-3 space-y-1.5 border-t border-line pt-3">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 text-[13px]">
            <dt className="flex min-w-0 items-center gap-2 text-fg-muted">
              {r.color && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />}
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

/** Effectifs détaillés : clients, chauffeurs, comptes des tableaux de bord, chauffeurs en ligne maintenant. */
export function HeadcountCards({ hc }: { hc: PlatformHeadcount }) {
  const { orgs, drivers, members } = hc;
  const online = drivers.online;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <HeadcountCard
        title="Clients"
        value={orgs.total}
        sub={plural(orgs.active, "actif", "actifs")}
        icon={<Building2 />}
        rows={[
          { label: "Flottes", value: orgs.fleet },
          { label: "Centrales à commission", value: orgs.centrale },
          { label: "Flotte Privée", value: orgs.privateFleet },
          { label: "Suspendus", value: orgs.suspended, tone: "amber" },
        ]}
      />
      <HeadcountCard
        title="Chauffeurs actifs"
        value={drivers.active}
        sub="tous clients"
        icon={<Users />}
        rows={[
          { label: "En ligne maintenant", value: drivers.online },
          { label: "Occupés (course acceptée)", value: drivers.busy },
          { label: "Candidatures en attente", value: drivers.applications, tone: "amber" },
          { label: "Bannis", value: drivers.banned, tone: "red" },
        ]}
      />
      <HeadcountCard
        title="Comptes des tableaux de bord"
        value={members.active}
        sub={members.invited ? `+ ${plural(members.invited, "invité", "invités")}` : "actifs"}
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
          <span className="text-[13px] text-fg-muted">En ligne maintenant</span>
          <Radio aria-hidden className="size-4 text-fg-subtle" />
        </div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="text-[26px] font-semibold leading-none tracking-tight tabular-nums">{formatNumber(online)}</span>
          <span className="text-[12.5px] text-fg-muted">sur {formatNumber(drivers.active)} actifs</span>
        </div>
        {/* Répartition par statut (couleurs de la carte en direct, chacune nommée dans la légende) */}
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-white/[0.05]" role="img" aria-label="Répartition des chauffeurs en ligne par statut">
          {ONLINE_PRESENCES.map((p) =>
            drivers.byPresence[p] ? <span key={p} style={{ width: `${(drivers.byPresence[p] / Math.max(1, online)) * 100}%`, background: PRESENCE_COLOR[p] }} /> : null,
          )}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
          {ONLINE_PRESENCES.map((p) => (
            <div key={p} className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-2 text-fg-muted">
                <span aria-hidden className="size-2 rounded-full" style={{ background: PRESENCE_COLOR[p] }} />
                {PRESENCE_SHORT[p]}
              </dt>
              <dd className={cn("tabular-nums", drivers.byPresence[p] ? "text-fg" : "text-fg-subtle")}>{drivers.byPresence[p]}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-auto pt-3">
          <Link href="/admin/carte" prefetch={false} className="inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-brand hover:underline sm:min-h-8">
            Voir sur la carte en direct <ChevronRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------------------------- tableau « Clients »

const count = (n: number | null) => (n === null ? "—" : formatNumber(n));

function KindBadge({ row }: { row: ClientActivityRow }) {
  if (!row.kind) return null;
  const meta = CLIENT_KIND_META[row.kind];
  return (
    <Badge tone={meta.tone} dot={false}>
      {meta.label}
    </Badge>
  );
}

function StatusBadge({ row }: { row: ClientActivityRow }) {
  const meta = ORG_STATUS_META[row.status];
  return <Badge tone={meta?.tone ?? "neutral"}>{meta?.label ?? "Statut inconnu"}</Badge>;
}

/** « 2 candidatures en attente » (petite note ambre), seulement s'il y en a. */
function Applications({ n }: { n: number | null }) {
  if (!n) return null;
  return <span className="text-amber">{plural(n, "candidature en attente", "candidatures en attente")}</span>;
}

const lastRide = (row: ClientActivityRow) => (row.lastRideAt ? formatRelative(row.lastRideAt) : "aucune course");

/**
 * Tableau « Clients » (fusion de « Effectifs par organisation » et « Activité des rattacheurs ») : client et son type,
 * statut, chauffeurs actifs et en ligne, courses du jour et sur 30 jours, courses restées sans chauffeur (7 jours),
 * dernière course. Cartes sous 768 px, tableau au-delà ; chaque ligne mène à la fiche du client.
 */
export function ClientsActivityCard({ rows, unavailable = false }: { rows: ClientActivityRow[]; unavailable?: boolean }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Clients"
        description="Les plus actifs aujourd'hui en premier."
        action={
          // Libellé court (tient à côté du titre sur téléphone) ; nom complet pour les lecteurs d'écran
          <Link href="/admin/organizations" prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-8">
            Tout voir<span className="sr-only">{"\u00a0: tous les clients"}</span>
          </Link>
        }
      />
      {unavailable ? (
        <CardBody className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</CardBody>
      ) : rows.length === 0 ? (
        <EmptyState size="compact" icon={<Building2 />} title="Aucun client pour l'instant." description={"Créez le premier depuis «\u00a0Clients\u00a0»."} />
      ) : (
        <>
          <MobileList>
            {rows.map((r) => {
              const online = r.driversOnline === null || r.driversActive === null ? "—" : `${formatNumber(r.driversOnline)} en ligne sur ${formatNumber(r.driversActive)}`;
              const today = r.ridesToday === null ? "— courses aujourd'hui" : plural(r.ridesToday, "course aujourd'hui", "courses aujourd'hui");
              // À surveiller (seulement s'il y a lieu) : client suspendu, courses restées sans chauffeur, candidatures
              const watch = [
                r.status !== "active" ? <span className="text-amber">{ORG_STATUS_META[r.status]?.label ?? "Inactif"}</span> : null,
                r.noDriver7d ? <span className="text-red">{`${formatNumber(r.noDriver7d)} sans chauffeur (7\u00a0j)`}</span> : null,
                r.applications ? <Applications n={r.applications} /> : null,
              ].filter(Boolean);
              return (
                <ListCard
                  key={r.id}
                  href={`/admin/organizations/${r.id}`}
                  title={r.name}
                  // Téléphone : le type à droite (le statut « Actif » de tous les clients en service n'apprend rien ; un
                  // client suspendu le dit sur la ligne « à surveiller ») ; le détail est dans le tableau, sur grand écran
                  status={<KindBadge row={r} />}
                  lines={[
                    `${online} · ${today}`,
                    watch.length ? (
                      <>
                        {watch.map((w, i) => (
                          <span key={i}>
                            {i > 0 && " · "}
                            {w}
                          </span>
                        ))}
                      </>
                    ) : null,
                  ]}
                />
              );
            })}
          </MobileList>
          <DesktopTable>
            <Table>
              <THead>
                <tr>
                  <TH>Client</TH>
                  <TH>Statut</TH>
                  <TH>Chauffeurs</TH>
                  <TH>Courses</TH>
                  <TH className="text-right">Sans chauffeur (7{"\u00a0"}j)</TH>
                  <TH>Dernière course</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((r) => (
                  <TR key={r.id} className="relative">
                    <TD className="py-2.5">
                      <Link href={`/admin/organizations/${r.id}`} prefetch={false} className="absolute inset-0" aria-label={r.name} />
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[14px] font-medium">{r.name}</span>
                        <KindBadge row={r} />
                      </span>
                      <span className="mt-0.5 block text-[12.5px] text-fg-muted">
                        {r.city ?? r.slug}
                        {r.applications ? (
                          <>
                            {" · "}
                            <Applications n={r.applications} />
                          </>
                        ) : null}
                      </span>
                    </TD>
                    <TD>
                      <StatusBadge row={r} />
                    </TD>
                    <TD className="num whitespace-nowrap py-2.5 text-[13px]">
                      <span className="block">{r.driversActive === null ? "—" : plural(r.driversActive, "actif", "actifs")}</span>
                      {r.driversOnline ? (
                        // Raccourci vers la carte en direct filtrée sur ce client (au-dessus du lien de la ligne)
                        <Link
                          href={`/admin/carte?org=${r.id}`}
                          prefetch={false}
                          className="relative z-10 -mx-1 inline-flex min-h-6 items-center rounded px-1 text-fg-muted underline-offset-2 hover:bg-white/[0.05] hover:text-fg hover:underline"
                          title="Voir ses chauffeurs sur la carte en direct"
                          aria-label={`${formatNumber(r.driversOnline)} en ligne\u00a0: voir ses chauffeurs sur la carte en direct`}
                        >
                          {formatNumber(r.driversOnline)}&nbsp;en ligne
                        </Link>
                      ) : (
                        <span className="block text-fg-muted">{count(r.driversOnline)}&nbsp;en ligne</span>
                      )}
                    </TD>
                    <TD className="num whitespace-nowrap py-2.5 text-[13px]">
                      <span className="block">{count(r.ridesToday)} aujourd&apos;hui</span>
                      <span className="block text-fg-muted">{count(r.rides30d)} sur 30&nbsp;j</span>
                    </TD>
                    <TD className={cn("num text-right", r.noDriver7d ? "text-red" : "text-fg-muted")}>{count(r.noDriver7d)}</TD>
                    <TD className="whitespace-nowrap text-[13px] text-fg-muted">{lastRide(r)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </DesktopTable>
        </>
      )}
    </Card>
  );
}
