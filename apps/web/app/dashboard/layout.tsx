import { localIsoDay, type SettlementMethod } from "@rydar/shared";
import { networkMenuShown } from "@/components/network-share/access";
import { networkNavState } from "@/components/network-share/nav";
import { networkTermsDue, shareOutRequested } from "@/components/network-share/readiness";
import { NetworkTermsBanner } from "@/components/network-share/terms-banner";
import { countExpiringDocuments, countQueue } from "@/components/private-fleet/queue";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { fetchCentraleCounts } from "@/components/settlements/counts";
import { OrgTermsGate, TermsBanner, UserTermsBanner } from "@/components/legal/terms-banner";
import { USER_TERMS_DOCUMENTS, orgTermsGate, termsBannerChoice } from "@/components/legal/terms-state";
import { loadChatCounts } from "@/app/dashboard/messages/queries";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { LEGAL_VERSION, ORG_LEGAL_EFFECTIVE_AT } from "@/lib/legal";
import { isPrivateFleet } from "@/lib/private-fleet";
import { countPendingDocuments } from "@/lib/queries/pending-documents";
import { networkAccess } from "@/lib/shared-network";

type Ctx = Awaited<ReturnType<typeof requireOrg>>;

/**
 * Lectures communes aux deux espaces : alerte « sans chauffeur » (organisation standard), CGV / accord de traitement,
 * CGU, frais Rydar (flotte).
 */
function commonReads(ctx: Ctx, admin: boolean, centrale: boolean, privateFleet: boolean) {
  return Promise.all([
    // Flotte Privée : alerte « non confirmées » lue avec la file à traiter (countQueue), sans les réservations qu'il a
    // refusées lui-même (aussi NO_DRIVER_FOUND) — jamais ce compte brut
    privateFleet
      ? Promise.resolve({ count: null })
      : ctx.supabase
          .from("rides")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", ctx.org.id)
          .eq("status", "NO_DRIVER_FOUND")
          .gte("pickup_at", new Date(Date.now() - 6 * 3600_000).toISOString()),
    // CGV + accord de traitement (owner / admin) : versions acceptées au nom de la centrale (une ligne par signataire
    // et par version ; « dpa » suffit, les deux documents sont enregistrés ensemble) → version en vigueur
    // (ORG_LEGAL_VERSION) acceptée, mise à jour à accepter (version antérieure seulement) ou première acceptation
    admin
      ? ctx.supabase
          .from("legal_acceptances")
          .select("version")
          .eq("organization_id", ctx.org.id)
          .eq("document", "dpa")
      : Promise.resolve(null),
    // CGU + politique de confidentialité acceptées à titre personnel (tout membre, dispatcher compris ; LEGAL_VERSION) :
    // ses propres lignes (RLS), quelle que soit la centrale au nom de laquelle il les a acceptées
    ctx.supabase
      .from("legal_acceptances")
      .select("document")
      .eq("user_id", ctx.user.id)
      .eq("version", LEGAL_VERSION)
      .in("document", [...USER_TERMS_DOCUMENTS]),
    // Flotte : frais Rydar par course réglés par le super admin (ou historique) → entrée « Frais Rydar » (owner / admin).
    // Le seul booléen (org_platform_fees_enabled) : le compte complet n'est calculé que par le bandeau et la page
    !centrale && admin ? ctx.supabase.rpc("org_platform_fees_enabled", { p_org: ctx.org.id }) : Promise.resolve(null),
  ]);
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrg();
  const centrale = ctx.org.dispatch_model === "centrale";
  const admin = isAdminRole(ctx.role);
  // Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.5) : ni messagerie, ni documents à valider, ni compteurs de centrale, ni
  // réseau partagé, ni mini-site, ni réglages d'encaissement ; à la place, les réservations à traiter et non confirmées
  // et les documents à renouveler (pastilles du menu). Gardés : alerte « non confirmées » (à la place du compte brut des
  // courses sans chauffeur), CGV et accord de traitement, CGU, frais Rydar.
  const privateFleet = isPrivateFleet(ctx.org);
  // Réseau partagé : interrupteur plateforme, puis le résumé de l'organisation (pastille du menu, bandeau « nouvelle
  // convention ») — réseau ouvert, ou fermé par Rydar avec des sommes en cours (organisation déjà membre) ; jamais
  // membre et réseau coupé : rien d'autre que l'interrupteur et l'adhésion. En parallèle des autres lectures.
  const network = privateFleet ? Promise.resolve(null) : networkAccess(ctx.supabase, ctx.org.id);
  const [[{ count }, terms, userTerms, fleetFees], chat, pendingDocs, centraleCounts, centraleSettings, bookingSites, networkInfo, queue, expiringDocuments] =
    await Promise.all([
      commonReads(ctx, admin, centrale, privateFleet),
      // Compteur « Messages » : non-lus de l'utilisateur connecté, tous fils confondus, et messages signalés à traiter
      // (comptages seuls : la liste des fils n'est lue que par la page Messages)
      privateFleet ? Promise.resolve(null) : loadChatCounts(ctx.supabase, ctx.org.id),
      // Compteur « Chauffeurs » : documents déposés à valider (candidats exclus, comme la page Chauffeurs)
      privateFleet ? Promise.resolve(null) : countPendingDocuments(ctx.supabase, ctx.org.id),
      // « Réseau » (centrale) / « Inscriptions » (flotte) : candidatures en attente ; mode centrale : « Encaissements »
      // (à confirmer + en retard)
      privateFleet ? Promise.resolve(null) : fetchCentraleCounts(ctx.supabase, ctx.org.id, { settlements: centrale }),
      // Mode centrale : lien de paiement et instructions (réclamations WhatsApp depuis les alertes et les fiches)
      centrale
        ? ctx.supabase
            .from("organization_settings")
            .select("settlement_link, settlement_instructions, settlement_methods, settlement_payee_name, settlement_iban, settlement_bic, block_unpaid")
            .eq("organization_id", ctx.org.id)
            .maybeSingle()
        : Promise.resolve(null),
      // Menu « Mini-site » : masqué tant que les mini-sites sont coupés par la plateforme (super admin)
      privateFleet ? Promise.resolve(false) : bookingSitesEnabled(),
      network,
      // Flotte Privée : pastilles « à traiter » et « non confirmées » (une lecture légère : statuts et offres des
      // réservations sans chauffeur ; une réservation qu'il a refusée n'est dans aucune des deux)
      privateFleet ? countQueue(ctx.supabase, ctx.org.id, ctx.driverId) : Promise.resolve(null),
      // … et « documents à renouveler » de sa fiche
      privateFleet ? countExpiringDocuments(ctx.supabase, ctx.org.id) : Promise.resolve(null),
    ]);
  // Un seul bandeau à la fois : celui de la centrale (owner / admin, CGU et politique comprises) d'abord, puis les CGU
  // à titre personnel, puis la nouvelle convention du réseau partagé (owner / admin)
  const termsBanner = termsBannerChoice({
    admin,
    orgVersions: terms && !terms.error ? ((terms.data ?? []) as { version: string }[]).map((a) => a.version) : null,
    userDocuments: userTerms.error ? null : ((userTerms.data ?? []) as { document: string }[]).map((a) => a.document),
  });
  // Organisation qui n'a jamais accepté les CGV : acceptation exigée (owner / admin), avant sa première course ou, déjà
  // en service, pour continuer (courses lues seulement dans ce cas, pour le texte de l'écran)
  const gate = orgTermsGate(termsBanner);
  let gateHasRides = false;
  if (gate) {
    const { data: anyRide } = await ctx.supabase.from("rides").select("id").eq("organization_id", ctx.org.id).limit(1);
    gateHasRides = (anyRide ?? []).length > 0;
  }
  // Date d'entrée en vigueur au plus tard des CGV atteinte (heure de Paris, comme la base) : bandeau « en vigueur depuis »
  const termsEffectivePassed = localIsoDay(new Date(), "Europe/Paris") >= ORG_LEGAL_EFFECTIVE_AT;
  // Réseau ouvert : menu (pastille à 0 si le résumé est illisible) ; nouvelle convention à accepter (owner / admin).
  // Réseau fermé par Rydar : menu seulement tant que des sommes ou des courses sont en cours, aucun bandeau
  const networkOpen = networkInfo?.mode === "open";
  const networkTerms = admin && networkOpen ? networkTermsDue(networkInfo.summary?.readiness) : null;
  const cs = (centraleSettings?.data ?? null) as {
    settlement_link: string | null;
    settlement_instructions: string | null;
    settlement_methods: SettlementMethod[] | null;
    settlement_payee_name: string | null;
    settlement_iban: string | null;
    settlement_bic: string | null;
    block_unpaid: boolean | null;
  } | null;
  return (
    <DashboardShell
      org={{ id: ctx.org.id, name: ctx.org.name, role: ctx.role }}
      orgs={ctx.memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }))}
      user={{ id: ctx.user.id, name: ctx.profile.full_name ?? ctx.profile.email, email: ctx.profile.email }}
      alerts={privateFleet ? undefined : (count ?? 0)}
      unreadMessages={chat?.unread ?? 0}
      openReports={chat?.openReports ?? 0}
      pendingDocuments={pendingDocs ?? 0}
      centrale={{
        model: ctx.org.dispatch_model ?? "fleet",
        orgId: ctx.org.id,
        orgName: ctx.org.name,
        timeZone: ctx.org.timezone || "Europe/Paris",
        role: ctx.role,
        link: cs?.settlement_link ?? null,
        instructions: cs?.settlement_instructions ?? null,
        methods: cs?.settlement_methods ?? [],
        bank: cs?.settlement_iban ? { payeeName: cs.settlement_payee_name || ctx.org.name, iban: cs.settlement_iban, bic: cs.settlement_bic } : null,
        blockUnpaid: cs?.block_unpaid ?? true,
        network: networkOpen ? { shareOut: shareOutRequested(networkInfo.summary?.readiness) } : null,
      }}
      centraleCounts={centraleCounts}
      topBanner={
        // Acceptation des CGV exigée (OrgTermsGate à la place de la page) : aucun bandeau
        gate ? null : termsBanner?.kind === "org" ? (
          <TermsBanner orgName={ctx.org.name} updated={termsBanner.updated} effectivePassed={termsEffectivePassed} />
        ) : termsBanner?.kind === "user" ? (
          <UserTermsBanner />
        ) : networkTerms ? (
          <NetworkTermsBanner
            orgName={ctx.org.name}
            version={networkTerms.version}
            graceUntil={networkTerms.graceUntil}
            expired={networkTerms.expired}
            timeZone={ctx.org.timezone || "Europe/Paris"}
          />
        ) : null
      }
      superAdmin={ctx.profile.is_super_admin === true}
      bookingSites={bookingSites}
      rydarFees={fleetFees?.data === true}
      sharedNetwork={networkMenuShown(networkInfo) ? networkNavState(networkInfo?.summary) : null}
      privateFleet={
        privateFleet
          ? { driverId: ctx.driverId, toTreat: queue?.toTreat ?? 0, notConfirmed: queue?.notConfirmed ?? 0, expiringDocuments: expiringDocuments ?? 0 }
          : null
      }
    >
      {gate ? <OrgTermsGate orgName={ctx.org.name} hasRides={gateHasRides} /> : children}
    </DashboardShell>
  );
}
