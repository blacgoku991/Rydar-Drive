"use client";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META } from "@rydar/shared";
import { KeyRound, Mail, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createDriver } from "@/app/dashboard/drivers/actions";
import { Button } from "@/components/ui/button";
import { Dialog, SheetContent } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { cn, submitWith } from "@/lib/utils";

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("") + "!";
}

export function DriverFormSheet() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [access, setAccess] = useState<"password" | "invite">("password");
  const [password, setPassword] = useState(generatePassword);
  const [category, setCategory] = useState<(typeof VEHICLE_CATEGORIES)[number]>("business");

  function submit(form: FormData) {
    const g = (k: string) => String(form.get(k) ?? "");
    start(async () => {
      const res = await createDriver({
        firstName: g("firstName"),
        lastName: g("lastName"),
        phone: g("phone"),
        email: g("email"),
        vtcCardNumber: g("vtc"),
        status: "active",
        access,
        password: access === "password" ? password : undefined,
        vehicle: {
          brand: g("brand"),
          model: g("model"),
          color: g("color"),
          plate: g("plate"),
          category,
          seats: Number(g("seats") || 4),
          luggageCapacity: Number(g("luggage") || 3),
        },
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success("Chauffeur créé", {
        description: access === "password" ? `Identifiants : ${g("email")} / ${password}` : "Invitation envoyée par e-mail.",
        duration: 15000,
      });
      setOpen(false);
      router.push(`/dashboard/drivers/${res.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <UserPlus /> Ajouter un chauffeur
      </Button>
      <SheetContent title="Nouveau chauffeur" description="Le chauffeur se connecte à l'application avec les identifiants que vous lui transmettez.">
        <form onSubmit={submitWith(submit)} className="flex min-h-full flex-col">
          <div className="flex-1 space-y-7 px-6 py-6">
            <section className="grid grid-cols-2 gap-3">
              <p className="col-span-2 text-[13px] font-medium text-fg-muted">Identité</p>
              <Field label="Prénom" error={errors.firstName}>
                <Input name="firstName" required placeholder="Mohamed" />
              </Field>
              <Field label="Nom" error={errors.lastName}>
                <Input name="lastName" required placeholder="Benali" />
              </Field>
              <Field label="Téléphone" error={errors.phone}>
                <Input name="phone" required placeholder="06 12 34 56 78" inputMode="tel" />
              </Field>
              <Field label="E-mail (identifiant)" error={errors.email}>
                <Input name="email" type="email" required placeholder="mohamed@centrale.fr" />
              </Field>
              <Field label="N° carte VTC" optional className="col-span-2">
                <Input name="vtc" placeholder="VTC-075-123456" />
              </Field>
            </section>

            <section className="grid grid-cols-2 gap-3">
              <p className="col-span-2 text-[13px] font-medium text-fg-muted">Véhicule</p>
              <Field label="Marque" optional>
                <Input name="brand" placeholder="Mercedes-Benz" />
              </Field>
              <Field label="Modèle" error={errors["vehicle.model"]}>
                <Input name="model" required placeholder="Classe E 300e" />
              </Field>
              <Field label="Plaque" error={errors["vehicle.plate"]}>
                <Input name="plate" required placeholder="GH-482-KT" className="num uppercase" />
              </Field>
              <Field label="Couleur" optional>
                <Input name="color" placeholder="Noir" />
              </Field>
              <div className="col-span-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
                {VEHICLE_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={cn("rounded-xl border px-3 py-2 text-left text-[12.5px] font-semibold", category === c ? "border-brand/50 bg-brand/[0.06] text-brand" : "border-line text-fg hover:border-line-strong")}
                  >
                    {VEHICLE_CATEGORY_META[c].label}
                  </button>
                ))}
              </div>
              <Field label="Places passagers">
                <Input name="seats" type="number" min={1} max={20} defaultValue={4} className="num" />
              </Field>
              <Field label="Bagages">
                <Input name="luggage" type="number" min={0} max={30} defaultValue={3} className="num" />
              </Field>
            </section>

            <section className="space-y-3">
              <p className="text-[13px] font-medium text-fg-muted">Accès à l&apos;application</p>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { k: "password", label: "Mot de passe", hint: "Vous transmettez les identifiants", icon: KeyRound },
                    { k: "invite", label: "Invitation", hint: "Lien envoyé par e-mail", icon: Mail },
                  ] as const
                ).map(({ k, label, hint, icon: Icon }) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setAccess(k)}
                    className={cn("flex items-start gap-3 rounded-xl border p-3 text-left", access === k ? "border-brand/50 bg-brand/[0.05]" : "border-line hover:border-line-strong")}
                  >
                    <Icon className={cn("mt-0.5 size-4", access === k ? "text-brand" : "text-fg-subtle")} />
                    <span>
                      <span className="block text-[13px] font-medium">{label}</span>
                      <span className="block text-[11.5px] text-fg-subtle">{hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              {access === "password" && (
                <Field label="Mot de passe provisoire" hint="À communiquer au chauffeur ; il pourra le changer." error={errors.password}>
                  <div className="flex gap-2">
                    <Input value={password} onChange={(e) => setPassword(e.target.value)} className="num" />
                    <Button type="button" variant="outline" onClick={() => setPassword(generatePassword())}>Générer</Button>
                  </div>
                </Field>
              )}
            </section>
          </div>
          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-ink-850/95 px-6 py-4 backdrop-blur">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" variant="primary" loading={pending}>Créer le chauffeur</Button>
          </div>
        </form>
      </SheetContent>
    </Dialog>
  );
}
