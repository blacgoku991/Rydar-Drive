"use client";
import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu as DM, Select as S, Switch as Sw, Tabs as T, Tooltip as Tt } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- Switch
export function Switch({ className, ...props }: React.ComponentProps<typeof Sw.Root>) {
  return (
    <Sw.Root
      className={cn(
        "peer inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-ink-600 p-0.5 transition-colors data-[state=checked]:border-brand/60 data-[state=checked]:bg-brand disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <Sw.Thumb className="block size-4 rounded-full bg-fg shadow transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-brand-fg" />
    </Sw.Root>
  );
}

// ---------------------------------------------------------------- Tabs
export const Tabs = T.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
  return (
    <T.List
      className={cn("inline-flex h-9 items-center gap-0.5 rounded-lg border border-line bg-ink-850 p-0.5", className)}
      {...props}
    />
  );
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        "inline-flex h-full items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-fg-muted transition-colors hover:text-fg data-[state=active]:bg-ink-600 data-[state=active]:text-fg data-[state=active]:shadow-[0_1px_0_rgb(255_255_255/0.05)_inset]",
        className,
      )}
      {...props}
    />
  );
}
export const TabsContent = T.Content;

// ---------------------------------------------------------------- Tooltip
export function Tooltip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <Tt.Provider delayDuration={150}>
      <Tt.Root>
        <Tt.Trigger asChild>{children}</Tt.Trigger>
        <Tt.Portal>
          <Tt.Content
            side={side}
            sideOffset={8}
            className="z-[60] rounded-md border border-line-strong bg-ink-600 px-2 py-1 text-xs text-fg shadow-float data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
          >
            {content}
          </Tt.Content>
        </Tt.Portal>
      </Tt.Root>
    </Tt.Provider>
  );
}

// ---------------------------------------------------------------- Select
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  name,
  disabled,
}: {
  value?: string;
  onValueChange?: (v: string) => void;
  options: { value: string; label: React.ReactNode; hint?: React.ReactNode }[];
  placeholder?: string;
  className?: string;
  name?: string;
  disabled?: boolean;
}) {
  return (
    <S.Root value={value} onValueChange={onValueChange} name={name} disabled={disabled}>
      <S.Trigger
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-ink-850 px-3 text-left text-sm text-fg outline-none hover:border-white/15 focus:border-brand/60 focus:ring-4 focus:ring-brand/10 data-[placeholder]:text-fg-subtle",
          className,
        )}
      >
        <S.Value placeholder={placeholder} />
        <S.Icon>
          <ChevronDown className="size-4 text-fg-subtle" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="z-[60] max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line-strong bg-ink-700 p-1 shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-pointer select-none flex-col rounded-lg py-2 pl-8 pr-3 text-sm text-fg outline-none data-[highlighted]:bg-white/[0.06]"
              >
                <S.ItemIndicator className="absolute left-2.5 top-2.5">
                  <Check className="size-3.5 text-brand" />
                </S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
                {o.hint && <span className="text-xs text-fg-subtle">{o.hint}</span>}
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

// ---------------------------------------------------------------- Dropdown
export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export function DropdownMenuContent({ className, ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        sideOffset={6}
        className={cn(
          "z-[60] min-w-48 rounded-xl border border-line-strong bg-ink-700 p-1 shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </DM.Portal>
  );
}
export function DropdownMenuItem({ className, destructive, ...props }: React.ComponentProps<typeof DM.Item> & { destructive?: boolean }) {
  return (
    <DM.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-white/[0.06] data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:text-fg-subtle",
        destructive ? "text-red [&_svg]:text-red" : "text-fg",
        className,
      )}
      {...props}
    />
  );
}
export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn("px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-subtle", className)} {...props} />;
}
export function DropdownMenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}

// ---------------------------------------------------------------- Divers
export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-line", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Avatar({
  name,
  src,
  size = 32,
  tone,
  className,
}: {
  name: string;
  src?: string | null;
  size?: number;
  tone?: string;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full border border-line-strong bg-gradient-to-b from-ink-500 to-ink-700 font-semibold text-fg", className)}
      style={{ width: size, height: size, fontSize: size * 0.36, boxShadow: tone ? `0 0 0 2px ${tone}33` : undefined }}
    >
      {src ? <img src={src} alt={name} className="size-full object-cover" /> : initials}
    </span>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon && (
        <div className="relative mb-4 grid size-12 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted [&_svg]:size-5">
          <div className="absolute inset-0 rounded-2xl bg-brand/5 blur-xl" />
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-fg-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
