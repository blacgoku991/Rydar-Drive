// Planning / Agenda (route /planning conservée : notifications et note App Review y mènent ; docs/FLOTTE-PRIVEE.md § 10.5).
// Vues Liste · Jour · Semaine · Mois : Liste par défaut pour un chauffeur standard (Planning inchangé : « Courses
// proposées » puis « Mes courses »), Mois en Flotte Privée ; vue choisie gardée en mémoire le temps de la session (aucun
// stockage sur le téléphone). Au-dessus de toutes les vues : « Courses proposées » (standard) ou le bloc « À traiter »
// (Flotte Privée : à confirmer, non confirmées — Confirmer, Refuser, La prendre, Annuler, Appeler). Données :
// driver_agenda sur la fenêtre de la vue (fetchWindow de @rydar/shared), repli sur driver_rides_upcoming (serveur
// antérieur) ; « Mes courses » : driver_rides_upcoming. Modèle de vue pur : lib/agenda-view.ts.
import { fetchWindow, type AgendaBooking, type AgendaView, type DriverOfferV2 } from "@rydar/shared";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BookingCard, CancelBookingSheet } from "@/components/agenda/booking-card";
import { DayTimeline } from "@/components/agenda/day-timeline";
import { EntryRow } from "@/components/agenda/entry-row";
import { MonthGrid } from "@/components/agenda/month-grid";
import { PeriodBar, TodayChip } from "@/components/agenda/period-bar";
import { MyRideCard, ProposedOfferCard } from "@/components/agenda/ride-cards";
import { WeekList } from "@/components/agenda/week-list";
import { frTypo } from "@/components/centrale";
import { BigButton, hapticResult, Screen, ScreenHeader, Segmented, useFlash } from "@/components/ui";
import { alertDriverBlocked, alertTakeAfterCurrent, useDriver } from "@/hooks/driver-context";
import { useNow } from "@/hooks/use-now";
import {
  agendaTitle, agendaViewOptions, calendarEntries, daySummaryText, declineBookingPrompt, defaultAgendaView, entriesByDay, entryTarget, entryView,
  listSections, monthCells, periodLabel, periodNavLabels, shiftDay, takenText, todayIn, todoCards, todoCardView, weekRows,
  type AgendaEntry, type EntryTarget, type TodoCard,
} from "@/lib/agenda-view";
import { api, ApiError, refusalText, type AcceptResult, type AgendaRead } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import type { AppRide, LegacyRideContext } from "@/lib/network";
import { offerSession } from "@/lib/offer-session";
import { answerBeforeText } from "@/lib/offer-urgency";
import { myRides } from "@/lib/planning";
import { colors, control, mono, space, type, weight } from "@/theme";

/** Vue choisie par le chauffeur, gardée en mémoire le temps de la session (aucune clé de stockage). */
let rememberedView: { driverId: string; view: AgendaView } | null = null;

/** Fuseau de repli (serveur antérieur sans fuseau dans l'agenda, accueil pas encore lu). */
const DEFAULT_TZ = "Europe/Paris";

const AGENDA_ERROR = "Connexion impossible : l'agenda n'est peut-être pas à jour.";

/** Réponse d'une action perdue (réseau) : refus neutre, message de l'erreur. */
const failed = (e: unknown) => ({ ok: false as const, code: e instanceof ApiError ? e.code ?? "NETWORK" : "NETWORK", message: (e as Error).message });

export default function Planning() {
  const { offers, refresh, home, privateFleet, ownerDriver } = useDriver();
  const params = useLocalSearchParams<{ focus?: string }>();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 64);
  // Heure dépassée, trait « maintenant », échéances : horloge de l'écran
  const now = useNow(30_000);
  const driverId = home?.driver.id;
  const driverIdRef = useRef(driverId);
  driverIdRef.current = driverId;
  const currentRideId = home?.driver.current_ride_id ?? null;

  // Vue : choisie (mémoire de session), sinon Liste (standard) ou Mois (Flotte Privée)
  const [pickedView, setPickedView] = useState<AgendaView | null>(null);
  const view = pickedView ?? (rememberedView && rememberedView.driverId === driverId ? rememberedView.view : null) ?? defaultAgendaView(privateFleet);
  const chooseView = useCallback(
    (v: AgendaView) => {
      if (driverIdRef.current) rememberedView = { driverId: driverIdRef.current, view: v };
      setPickedView(v);
    },
    [],
  );
  const listView = view === "list";

  const [upcoming, setUpcoming] = useState<AppRide[] | null>(null);
  const [agenda, setAgenda] = useState<{ key: string; data: AgendaRead } | null>(null);
  // Réservations à traiter (Flotte Privée) : indépendantes de la période, gardées d'une lecture à l'autre
  const [unassigned, setUnassigned] = useState<AgendaBooking[] | null>(null);
  // Lecture en échec (réseau) : dernière vue gardée, jamais « Aucune course »
  const [upError, setUpError] = useState(false);
  const [agError, setAgError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const tz = agenda?.data.timezone || home?.organization.timezone || DEFAULT_TZ;
  const today = todayIn(tz, now);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const day = pickedDay ?? today;
  // Fenêtre de lecture de la vue (jours affichés ± 1 jour, 44 jours au plus)
  const span = useMemo(() => fetchWindow(view, day), [view, day]);
  const spanKey = `${span.from}|${span.to}`;
  const needUpcoming = listView || privateFleet;
  const needAgenda = !listView || privateFleet;

  // Serveur antérieur à driver_rides_upcoming / driver_agenda : argent déduit du modèle de l'organisation
  const legacy = useRef<LegacyRideContext>({});
  legacy.current = { model: home?.model ?? home?.organization.dispatch_model, organization: home?.organization.name };

  // Relectures : à l'affichage (accueil compris), « tirer pour actualiser », course changée (temps réel, notification),
  // offres, réservations à traiter ou période changées ; jamais écran caché (la relecture du retour suffit)
  const [nonce, setNonce] = useState(0);
  const focusedRef = useRef(false);
  const homeWanted = useRef(false);
  const reload = useCallback((withHome = false) => {
    if (withHome) homeWanted.current = true;
    setNonce((n) => n + 1);
  }, []);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      reload(true);
      return () => {
        focusedRef.current = false;
      };
    }, [reload]),
  );
  useAppEvent("ride", () => {
    if (focusedRef.current) reload();
  });
  const offerKey = offers.filter((o) => !o.network).map((o) => `${o.offer_id}:${o.expires_at ?? ""}`).join(",");
  const homeKey = `${home?.private?.unassigned ?? ""}|${home?.next_scheduled?.id ?? ""}|${currentRideId ?? ""}`;

  useEffect(() => {
    if (nonce === 0 || !focusedRef.current) return;
    let alive = true;
    const withHome = homeWanted.current;
    homeWanted.current = false;
    const read = (id: string) =>
      Promise.all([
        needUpcoming ? api.upcoming(id, legacy.current).catch(() => null) : Promise.resolve(undefined),
        needAgenda ? api.agenda(span.from, span.to, id, legacy.current).catch(() => null) : Promise.resolve(undefined),
      ]);
    void (async () => {
      // Fiche du chauffeur connue : lectures en même temps que l'accueil ; sinon après lui (accueil illisible : erreur)
      const known = driverIdRef.current;
      const [h, first] = await Promise.all([withHome ? refresh() : Promise.resolve(null), known ? read(known) : Promise.resolve(null)]);
      const id = known ?? h?.driver.id;
      const res = first ?? (id ? await read(id) : null);
      if (!alive) return;
      if (!res) {
        setUpError(needUpcoming);
        setAgError(needAgenda);
        return;
      }
      const [up, ag] = res;
      setUpError(up === null);
      setAgError(ag === null);
      if (up) setUpcoming(up);
      if (ag) {
        setAgenda({ key: spanKey, data: ag });
        setUnassigned(ag.unassigned);
      }
    })().finally(() => {
      if (alive) setRefreshing(false);
    });
    return () => {
      alive = false;
    };
  }, [nonce, spanKey, offerKey, homeKey, needUpcoming, needAgenda]);

  const pull = useCallback(() => {
    setRefreshing(true);
    reload(true);
  }, [reload]);

  // --- Données affichées -------------------------------------------------------------------------------------------
  const mine = useMemo(() => (upcoming && driverId ? myRides(upcoming, driverId) : null), [upcoming, driverId]);
  const sections = useMemo(() => (mine ? listSections(mine, tz, today) : []), [mine, tz, today]);
  const loaded = agenda?.key === spanKey ? agenda.data : null;
  const entries = useMemo(
    () => (loaded ? calendarEntries<AgendaEntry>(loaded.rides, privateFleet ? loaded.unassigned : null) : []),
    [loaded, privateFleet],
  );
  const byDay = useMemo(() => entriesByDay(entries, tz), [entries, tz]);
  // Montants : sa part (course de centrale ou partenaire) ou le prix, comme la vue Liste ; fiche du gérant : le prix
  const week = useMemo(
    () => (view === "week" && loaded ? weekRows(day, byDay, { today, now, tz, ownerDriver }) : null),
    [view, loaded, day, byDay, today, now, tz, ownerDriver],
  );
  const available = offers.filter((o) => o.mode === "fleet");
  // Flotte Privée : réservations à traiter (agenda + offres en attente) ; chevauchements avec ses courses confirmées
  const todo = useMemo(() => (privateFleet ? todoCards(unassigned, offers) : null), [privateFleet, unassigned, offers]);
  const confirmed = useMemo<AgendaEntry[]>(() => [...(upcoming ?? []), ...(loaded?.rides ?? [])], [upcoming, loaded]);

  // --- Réservation mise en avant (notification « non confirmée », élément touché dans le calendrier) ------------------
  const [focusId, setFocusId] = useState<string | null>(typeof params.focus === "string" ? params.focus : null);
  useEffect(() => {
    if (typeof params.focus === "string" && params.focus) setFocusId(params.focus);
  }, [params.focus]);
  const scrollRef = useRef<ScrollView>(null);
  const todoY = useRef<number | null>(null);
  const cardY = useRef(new Map<string, number>());
  const scrolledTo = useRef<string | null>(null);
  const scrollToFocus = useCallback(() => {
    if (!focusId || scrolledTo.current === focusId || todoY.current == null) return;
    const y = cardY.current.get(focusId);
    if (y == null) return;
    scrolledTo.current = focusId;
    scrollRef.current?.scrollTo({ y: Math.max(0, todoY.current + y - space.md), animated: true });
  }, [focusId]);
  useEffect(() => scrollToFocus(), [scrollToFocus, todo]);

  const openEntry = useCallback((t: EntryTarget) => {
    if (t.kind === "ride") router.push({ pathname: "/ride/[id]", params: { id: t.id } });
    else if (t.kind === "offer") router.push({ pathname: "/offer/[id]", params: { id: t.id } });
    else {
      // Réservation sans offre (à vérifier, non confirmée, refusée) : sa carte du bloc « À traiter »
      scrolledTo.current = null;
      setFocusId(t.id);
    }
  }, []);

  // --- Actions -----------------------------------------------------------------------------------------------------
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<TodoCard | null>(null);

  /** Après une action : accueil (offres, pastille) et agenda relus. */
  const after = useCallback(() => reload(true), [reload]);

  /** « Prendre cette course » (offre planifiée de la flotte, chauffeur standard). */
  async function takeOffer(o: DriverOfferV2) {
    setBusyId(o.offer_id);
    const res = await api.accept(o.offer_id).catch((e: Error) => ({ ok: false, code: "NETWORK", message: e.message }) as AcceptResult);
    setBusyId(null);
    if (!res.ok && res.code === "DRIVER_BLOCKED") alertDriverBlocked(res, { giver: o.network?.giver.name, executor: home?.organization.name });
    else
      Alert.alert(
        res.ok ? "Course attribuée" : "Course indisponible",
        res.ok ? "Ajoutée à votre planning. Rappels programmés." : frTypo(refusalText(res)),
      );
    after();
  }

  /** Confirmer (offre en attente) : DRIVER_BUSY → « La prendre à la suite ? ». */
  async function confirm(c: TodoCard) {
    if (busyId) return;
    if (!c.offerId) return take(c);
    setBusyId(c.rideId);
    const res: AcceptResult = await api.accept(c.offerId).catch(failed);
    setBusyId(null);
    if (res.ok) {
      offerSession.accepted.add(c.offerId);
      hapticResult(true);
      if (c.type === "instant" && res.ride_id) router.push({ pathname: "/ride/[id]", params: { id: String(res.ride_id) } });
      else {
        const done = takenText(res);
        flash.show(`${done.title}. ${done.message}`);
      }
    } else if (res.code === "DRIVER_BUSY") alertTakeAfterCurrent(c.rideId, after);
    else if (res.code === "DRIVER_BLOCKED") alertDriverBlocked(res, { executor: home?.organization.name });
    else {
      hapticResult(false);
      Alert.alert(res.code === "OFFER_EXPIRED" ? "Délai de réponse dépassé" : "Réservation indisponible", frTypo(refusalText(res, "Réessayez.")));
    }
    after();
  }

  /** Refuser (confirmation, comme l'écran d'offre) : la réservation passe « Refusée », le site en est informé. */
  function decline(c: TodoCard) {
    const offerId = c.offerId;
    if (!offerId || busyId) return;
    const prompt = declineBookingPrompt(c.number);
    Alert.alert(prompt.title, prompt.message, [
      { text: "Annuler", style: "cancel" },
      {
        text: prompt.confirm,
        style: "destructive",
        onPress: async () => {
          setBusyId(c.rideId);
          const res = await api.decline(offerId).catch(failed);
          setBusyId(null);
          hapticResult(res.ok);
          if (res.ok) flash.show("Réservation refusée.");
          else Alert.alert("Refus impossible", frTypo(refusalText(res, "Réessayez.")));
          after();
        },
      },
    ]);
  }

  /** La prendre (confirmation) : driver_take_ride — acceptée, ou attribuée (enchaînée après la course en cours). */
  function take(c: TodoCard) {
    if (busyId) return;
    Alert.alert(frTypo(`Prendre la réservation ${c.number} ?`), "Elle sera ajoutée à votre agenda et votre site en sera informé.", [
      { text: "Annuler", style: "cancel" },
      {
        text: "La prendre",
        onPress: async () => {
          setBusyId(c.rideId);
          const res = await api.takeRide(c.rideId).catch(failed);
          setBusyId(null);
          hapticResult(res.ok);
          if (res.ok) {
            if (c.offerId) offerSession.accepted.add(c.offerId);
            const chained = res.code === "ACCEPTED" && res.chained === true;
            if (c.type === "instant" && !chained && res.code === "ACCEPTED") router.push({ pathname: "/ride/[id]", params: { id: c.rideId } });
            else {
              const done = takenText(res);
              flash.show(`${done.title}. ${done.message}`);
            }
          } else Alert.alert("Action impossible", frTypo(refusalText(res, "Réessayez.")));
          after();
        },
      },
    ]);
  }

  /** Annuler la réservation (motif) : cancel_ride — le chauffeur d'une Flotte Privée est le propriétaire. */
  async function cancelBooking(reason: string): Promise<string | null> {
    if (!cancelling) return null;
    const res = await api.cancelRide(cancelling.rideId, reason).catch(failed);
    if (!res.ok) {
      hapticResult(false);
      return refusalText(res, "Annulation impossible. Réessayez.");
    }
    hapticResult(true);
    setCancelling(null);
    flash.show("Réservation annulée.");
    after();
    return null;
  }

  function call(c: TodoCard) {
    if (!c.customerPhone) return;
    void Linking.openURL(`tel:${c.customerPhone}`).catch(() => Alert.alert("Appel impossible", frTypo(`Composez le ${c.customerPhone}.`)));
  }

  // --- Rendu -------------------------------------------------------------------------------------------------------
  const nav = periodNavLabels(view);
  const dayItems = byDay[day] ?? [];
  const loading = <Text style={styles.empty} accessibilityLiveRegion="polite">{agError ? "" : "Chargement…"}</Text>;

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <ScreenHeader title={agendaTitle(privateFleet)} right={listView ? undefined : <TodayChip onPress={() => setPickedDay(null)} />} />
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl tintColor={colors.muted} colors={[colors.fg]} progressBackgroundColor={colors.surface2} refreshing={refreshing} onRefresh={pull} />}
        >
          <Segmented options={agendaViewOptions()} value={view} onChange={chooseView} />

          {agError && (!listView || privateFleet) ? (
            <View style={styles.error} accessibilityRole="alert">
              <Text style={styles.errorText}>{frTypo(AGENDA_ERROR)}</Text>
              <BigButton title="Réessayer" icon="refresh-outline" variant="secondary" height={control.md} loading={refreshing} onPress={pull} />
            </View>
          ) : null}

          {todo ? (
            // Flotte Privée : bloc « À traiter »
            <View
              style={styles.block}
              onLayout={(e) => {
                todoY.current = e.nativeEvent.layout.y;
                scrollToFocus();
              }}
            >
              <Text style={styles.section} accessibilityRole="header">
                À confirmer <Text style={mono}>· {todo.toConfirm.length}</Text>
              </Text>
              {todo.toConfirm.length === 0 && <Text style={styles.empty}>Aucune réservation à confirmer.</Text>}
              {todo.toConfirm.map((c) => (
                <BookingCard
                  key={c.rideId}
                  card={c}
                  view={todoCardView(c, { tz, now, vehicle: home?.vehicle, rides: confirmed, answerBefore: answerBeforeText(c.expiresAt, tz, now) })}
                  highlighted={c.rideId === focusId}
                  busy={busyId === c.rideId}
                  disabled={busyId != null && busyId !== c.rideId}
                  onConfirm={() => void confirm(c)}
                  onDecline={() => decline(c)}
                  onTake={() => take(c)}
                  onCancel={() => setCancelling(c)}
                  onCall={() => call(c)}
                  onLayout={(e) => {
                    cardY.current.set(c.rideId, e.nativeEvent.layout.y);
                    scrollToFocus();
                  }}
                />
              ))}
              {todo.unconfirmed.length > 0 && (
                <Text style={[styles.section, styles.sectionGap]} accessibilityRole="header">
                  Non confirmées <Text style={mono}>· {todo.unconfirmed.length}</Text>
                </Text>
              )}
              {todo.unconfirmed.map((c) => (
                <BookingCard
                  key={c.rideId}
                  card={c}
                  view={todoCardView(c, { tz, now, vehicle: home?.vehicle, rides: confirmed, answerBefore: null })}
                  highlighted={c.rideId === focusId}
                  busy={busyId === c.rideId}
                  disabled={busyId != null && busyId !== c.rideId}
                  onConfirm={() => void confirm(c)}
                  onDecline={() => decline(c)}
                  onTake={() => take(c)}
                  onCancel={() => setCancelling(c)}
                  onCall={() => call(c)}
                  onLayout={(e) => {
                    cardY.current.set(c.rideId, e.nativeEvent.layout.y);
                    scrollToFocus();
                  }}
                />
              ))}
            </View>
          ) : (
            // Chauffeur standard : offres planifiées de la flotte (comme le Planning d'avant l'agenda)
            <View style={styles.block}>
              <Text style={styles.section} accessibilityRole="header">
                Courses proposées <Text style={mono}>· {available.length}</Text>
              </Text>
              {available.length === 0 && <Text style={styles.empty}>Aucune course planifiée à prendre pour le moment.</Text>}
              {available.map((o) => (
                <ProposedOfferCard
                  key={o.offer_id}
                  o={o}
                  tz={home?.organization.timezone}
                  organization={home?.organization.name}
                  ownerDriver={ownerDriver}
                  busy={busyId === o.offer_id}
                  disabled={busyId != null && busyId !== o.offer_id}
                  onTake={() => void takeOffer(o)}
                />
              ))}
            </View>
          )}

          {listView ? (
            <View style={[styles.block, styles.sectionGap]}>
              <Text style={styles.section} accessibilityRole="header">
                Mes courses {mine ? <Text style={mono}>· {mine.length}</Text> : null}
              </Text>
              {upError ? (
                <View style={styles.error} accessibilityRole="alert">
                  <Text style={styles.errorText}>
                    {frTypo(mine ? "Connexion impossible : cette liste n'est peut-être pas à jour." : "Connexion impossible : vos courses n'ont pas pu être chargées.")}
                  </Text>
                  <BigButton title="Réessayer" icon="refresh-outline" variant="secondary" height={control.md} loading={refreshing} onPress={pull} />
                </View>
              ) : null}
              {mine?.length === 0 && <Text style={styles.empty}>Aucune course à venir.</Text>}
              {sections.map((s) => (
                <View key={s.day} style={styles.block}>
                  <Text style={styles.dayHeading} accessibilityRole="header">{s.title}</Text>
                  {s.items.map((r) => (
                    <MyRideCard key={r.id} r={r} tz={home?.organization.timezone} now={now} currentRideId={currentRideId} ownerDriver={ownerDriver} />
                  ))}
                </View>
              ))}
            </View>
          ) : (
            <View style={[styles.block, styles.sectionGap]}>
              <PeriodBar
                label={periodLabel(view, day)}
                prevLabel={nav.prev}
                nextLabel={nav.next}
                onPrev={() => setPickedDay(shiftDay(view, day, -1))}
                onNext={() => setPickedDay(shiftDay(view, day, 1))}
              />
              {view === "day" &&
                (!loaded ? (
                  loading
                ) : dayItems.length === 0 ? (
                  <Text style={styles.empty}>Aucune course ce jour-là.</Text>
                ) : (
                  <>
                    <Text style={styles.summary}>{daySummaryText(dayItems, { now, ownerDriver })}</Text>
                    <DayTimeline day={day} items={dayItems} tz={tz} now={now} isToday={day === today} ownerDriver={ownerDriver} onOpen={openEntry} />
                  </>
                ))}
              {view === "week" &&
                (!week ? (
                  loading
                ) : (
                  <>
                    {week.every((r) => r.lines.length === 0) && <Text style={styles.empty}>Aucune course cette semaine.</Text>}
                    <WeekList
                      rows={week}
                      onOpenDay={(d) => {
                        setPickedDay(d);
                        chooseView("day");
                      }}
                    />
                  </>
                ))}
              {view === "month" && (
                <>
                  <MonthGrid cells={monthCells(day, loaded ? byDay : {}, { today, selected: day, now })} onSelect={setPickedDay} />
                  {!loaded ? (
                    loading
                  ) : (
                    <View style={styles.block}>
                      <View style={styles.dayHead}>
                        <Text style={styles.dayHeading} accessibilityRole="header">{periodLabel("day", day)}</Text>
                        <Text style={styles.summary}>{daySummaryText(dayItems, { now, ownerDriver })}</Text>
                      </View>
                      {dayItems.length === 0 ? (
                        <Text style={styles.empty}>Aucune course ce jour-là.</Text>
                      ) : (
                        dayItems.map((e) => <EntryRow key={e.id} v={entryView(e, { tz, now, ownerDriver })} onPress={() => openEntry(entryTarget(e))} />)
                      )}
                    </View>
                  )}
                </>
              )}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
      <CancelBookingSheet
        target={cancelling ? { rideId: cancelling.rideId, number: cancelling.number, pickupAddress: cancelling.pickupAddress, dropoffAddress: cancelling.dropoffAddress } : null}
        onClose={() => setCancelling(null)}
        onSubmit={cancelBooking}
      />
      {flash.node}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl + space.sm, gap: space.md },
  block: { gap: space.md },
  section: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.semibold },
  sectionGap: { marginTop: space.lg },
  dayHeading: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  dayHead: { gap: 2 },
  summary: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.medium, ...mono },
  empty: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  error: { gap: space.sm },
  errorText: { color: colors.fg, fontSize: type.body, lineHeight: 21 },
});
