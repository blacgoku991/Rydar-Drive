"use client";
import { ArrowRight, LockKeyhole, Mail } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { signIn, type LoginState } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next ?? ""} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Adresse e-mail</Label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={state.email} placeholder="vous@centrale.fr" className="h-11 pl-9" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Mot de passe</Label>
          <a href="/forgot-password" className="text-xs text-fg-subtle transition-colors hover:text-fg">
            Mot de passe oublié ?
          </a>
        </div>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input id="password" name="password" type="password" autoComplete="current-password" required placeholder="••••••••••" className="h-11 pl-9" />
        </div>
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg border border-red/25 bg-red/10 px-3 py-2 text-[13px] text-red">
          {state.error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-2 w-full">
        Se connecter <ArrowRight />
      </Button>
    </form>
  );
}
