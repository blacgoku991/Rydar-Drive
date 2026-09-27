"use client";
import type { ChatMessage, ChatModerationEvent, ChatReadEvent } from "@rydar/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchChatUnread } from "@/app/dashboard/messages/actions";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";

type Ctx = {
  /** Non-lus de l'utilisateur connecté (tous fils confondus) */
  unread: number;
  /** Messages du fil flotte signalés par les chauffeurs, en attente de décision (supprimer / ignorer) */
  openReports: number;
  /** Fil affiché à l'écran (page Messages) : ses messages ne comptent pas comme non-lus tant que l'onglet est visible. */
  setOpenThread: (thread: string | null) => void;
  /** Recalcule les compteurs (après un marquage « lu », une suppression ou un classement). */
  refresh: () => void;
};

const ChatUnreadContext = createContext<Ctx | null>(null);

// Fil ouvert, lisible hors React (ex. pour couper le toast d'un message déjà affiché).
let openThread: string | null = null;
/** Fil de messagerie actuellement affiché et visible (« fleet » | « driver:<id> »), sinon null. */
export function getOpenChatThread(): string | null {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return null;
  return openThread;
}

/**
 * Compteurs de la barre latérale : valeur serveur + temps réel. Non-lus : chat.message / chat.read ; messages
 * signalés à traiter : chat.moderation (signalé, classé ou supprimé, ici ou par un autre membre de la centrale).
 * initialOpenReports absent : lu une fois au montage.
 */
export function ChatUnreadProvider({
  initial,
  initialOpenReports,
  userId,
  children,
}: {
  initial: number;
  initialOpenReports?: number;
  userId: string;
  children: React.ReactNode;
}) {
  const [unread, setUnread] = useState(initial);
  const [openReports, setOpenReports] = useState(initialOpenReports ?? 0);
  const timer = useRef<number | null>(null);

  // Nouvelle valeur serveur (navigation, router.refresh) : elle fait foi.
  useEffect(() => setUnread(initial), [initial]);
  useEffect(() => {
    if (initialOpenReports != null) setOpenReports(initialOpenReports);
  }, [initialOpenReports]);

  const refresh = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const counts = await fetchChatUnread().catch(() => null);
      if (!counts) return;
      setUnread(counts.unread);
      setOpenReports(counts.openReports);
    }, 350);
  }, []);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  // Messages signalés : pas de valeur fournie par la page → une lecture au montage
  const fetchInitial = useRef(initialOpenReports == null);
  useEffect(() => {
    if (fetchInitial.current) refresh();
  }, [refresh]);

  useRealtimeEvent("chat.message", (m: ChatMessage) => {
    if (!m?.id || (m.author_type === "user" && m.author_user_id === userId)) return;
    if (getOpenChatThread() === m.thread) return;
    setUnread((n) => n + 1);
  });
  useRealtimeEvent("chat.read", (e: ChatReadEvent) => {
    if (e?.reader_key === `user:${userId}`) refresh();
  });
  useRealtimeEvent("chat.moderation", (e: ChatModerationEvent) => {
    if (e?.message_id) refresh();
  });

  const setOpenThread = useCallback((thread: string | null) => {
    openThread = thread;
  }, []);
  useEffect(() => () => {
    openThread = null;
  }, []);

  const value = useMemo(() => ({ unread, openReports, setOpenThread, refresh }), [unread, openReports, setOpenThread, refresh]);
  return <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>;
}

export function useChatUnread(): Ctx {
  return useContext(ChatUnreadContext) ?? { unread: 0, openReports: 0, setOpenThread: () => {}, refresh: () => {} };
}
