"use client";
import type { ChatMessage, ChatReadEvent } from "@rydar/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchChatUnread } from "@/app/dashboard/messages/actions";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";

type Ctx = {
  /** Non-lus de l'utilisateur connecté (tous fils confondus) */
  unread: number;
  /** Fil affiché à l'écran (page Messages) : ses messages ne comptent pas comme non-lus tant que l'onglet est visible. */
  setOpenThread: (thread: string | null) => void;
  /** Recalcule le compteur (après un marquage « lu »). */
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

/** Compteur de non-lus de la barre latérale : valeur serveur + temps réel (chat.message / chat.read). */
export function ChatUnreadProvider({ initial, userId, children }: { initial: number; userId: string; children: React.ReactNode }) {
  const [unread, setUnread] = useState(initial);
  const timer = useRef<number | null>(null);

  // Nouvelle valeur serveur (navigation, router.refresh) : elle fait foi.
  useEffect(() => setUnread(initial), [initial]);

  const refresh = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const n = await fetchChatUnread().catch(() => null);
      if (n != null) setUnread(n);
    }, 350);
  }, []);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  useRealtimeEvent("chat.message", (m: ChatMessage) => {
    if (!m?.id || (m.author_type === "user" && m.author_user_id === userId)) return;
    if (getOpenChatThread() === m.thread) return;
    setUnread((n) => n + 1);
  });
  useRealtimeEvent("chat.read", (e: ChatReadEvent) => {
    if (e?.reader_key === `user:${userId}`) refresh();
  });

  const setOpenThread = useCallback((thread: string | null) => {
    openThread = thread;
  }, []);
  useEffect(() => () => {
    openThread = null;
  }, []);

  const value = useMemo(() => ({ unread, setOpenThread, refresh }), [unread, setOpenThread, refresh]);
  return <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>;
}

export function useChatUnread(): Ctx {
  return useContext(ChatUnreadContext) ?? { unread: 0, setOpenThread: () => {}, refresh: () => {} };
}
