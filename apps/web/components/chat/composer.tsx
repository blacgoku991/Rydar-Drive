"use client";
import { CircleAlert, SendHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { CHAT_MAX_LENGTH } from "./chat-utils";

/** Zone de saisie : Entrée = envoyer, Maj+Entrée = retour à la ligne, compteur, réponses rapides. */
export function Composer({
  value,
  onChange,
  onSend,
  sending,
  error,
  placeholder,
  quickReplies,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string) => void;
  sending: boolean;
  error: string | null;
  placeholder: string;
  quickReplies: string[];
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const length = value.trim().length;
  const tooLong = value.length > CHAT_MAX_LENGTH;
  const canSend = !sending && !disabled && length > 0 && !tooLong;

  // Hauteur automatique (1 à ~6 lignes)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 156)}px`;
  }, [value]);

  // Focus à l'ouverture sur ordinateur (pas sur mobile : le clavier masquerait le fil)
  useEffect(() => {
    if (autoFocus !== false && window.matchMedia?.("(pointer: fine)").matches) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const submit = () => {
    if (canSend) onSend(value.trim());
  };

  return (
    <div className="border-t border-line bg-ink-900/80 px-3 pb-3 pt-2.5 backdrop-blur sm:px-5">
      {quickReplies.length > 0 && (
        <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]" role="group" aria-label="Réponses rapides">
          {quickReplies.map((q) => (
            <button
              key={q}
              type="button"
              disabled={sending || disabled}
              onClick={() => onSend(q)}
              className="h-7 shrink-0 rounded-full border border-line-strong bg-white/[0.03] px-3 text-[12.5px] text-fg-muted transition-colors hover:border-brand/40 hover:bg-brand/[0.06] hover:text-fg disabled:opacity-40"
            >
              {q}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className={cn(
          "flex items-end gap-2 rounded-2xl border bg-ink-800 p-1.5 pl-3.5 transition-colors focus-within:border-brand/40 focus-within:ring-4 focus-within:ring-brand/[0.07]",
          error || tooLong ? "border-red/40" : "border-line-strong",
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          // Lecture seule pendant l'envoi : le champ garde le focus (clavier mobile ouvert)
          readOnly={sending}
          disabled={disabled}
          aria-busy={sending}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={!!error || tooLong}
          className="max-h-[156px] min-h-[36px] flex-1 resize-none bg-transparent py-[7px] text-[14px] leading-[1.45] text-fg outline-none placeholder:text-fg-subtle read-only:opacity-60 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Envoyer"
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl transition-all",
            canSend ? "bg-brand text-brand-fg hover:bg-brand-strong active:scale-95" : "bg-white/[0.05] text-fg-subtle",
          )}
        >
          {sending ? (
            <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
          ) : (
            <SendHorizontal className="size-4" />
          )}
        </button>
      </form>
      <div className="mt-1.5 flex min-h-[18px] items-center justify-between gap-3 px-1 text-[11.5px]">
        {error ? (
          <span className="flex items-center gap-1.5 text-red" role="alert">
            <CircleAlert className="size-3.5 shrink-0" /> {error}
          </span>
        ) : (
          <span className="hidden text-fg-subtle sm:inline">
            <kbd className="font-sans text-fg-muted">Entrée</kbd> pour envoyer · <kbd className="font-sans text-fg-muted">Maj + Entrée</kbd> pour aller à la ligne
          </span>
        )}
        <span className={cn("ml-auto font-mono tabular-nums", tooLong ? "text-red" : value.length > CHAT_MAX_LENGTH * 0.8 ? "text-amber" : "text-fg-subtle")}>
          {value.length}/{CHAT_MAX_LENGTH}
        </span>
      </div>
    </div>
  );
}
