"use client";
// Réglages › Organisation (Flotte Privée : « Coordonnées »), docs/REFONTE-PANELS.md § 5.6 (R10) : « Identité de votre
// entreprise ». Les informations exigées pour vos factures et la mise en ligne (raison sociale, SIRET, adresse
// complète, n° d'inscription au registre VTC : bookingOperatorGaps, même règle que le mini-site) ne sont plus dites
// « optionnelles » : un résumé en tête dit ce qui manque, une aide sous chaque champ vide. Erreurs sous les champs
// (fieldErrors de updateOrganization, action et validation inchangées).
import { bookingOperatorGaps } from "@rydar/shared";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateOrganization } from "@/app/dashboard/settings/actions";
import { UnsavedGuard } from "@/components/settings/unsaved-guard";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";
import { plural } from "@/lib/wording";

const NB = " ";

export type OrganizationRow = {
  name: string;
  legal_name: string | null;
  siret: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  vtc_registration: string | null;
};

type Values = {
  name: string;
  legalName: string;
  siret: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postalCode: string;
  vtcRegistration: string;
};

const fromRow = (o: OrganizationRow): Values => ({
  name: o.name ?? "",
  legalName: o.legal_name ?? "",
  siret: o.siret ?? "",
  email: o.email ?? "",
  phone: o.phone ?? "",
  address: o.address ?? "",
  city: o.city ?? "",
  postalCode: o.postal_code ?? "",
  vtcRegistration: o.vtc_registration ?? "",
});

/** Champs que bookingOperatorGaps exige (adresse complète = rue, code postal et ville). */
const NEEDED: (keyof Values)[] = ["legalName", "siret", "address", "postalCode", "city", "vtcRegistration"];

export function OrganizationForm({ org, readOnly, privateFleet = false }: { org: OrganizationRow; readOnly: boolean; privateFleet?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [baseline, setBaseline] = useState<Values>(() => fromRow(org));
  const [v, setV] = useState<Values>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(v) !== JSON.stringify(baseline);
  const set = (k: keyof Values, value: string) => {
    setV((cur) => ({ ...cur, [k]: value }));
    setErrors(({ [k]: _drop, ...rest }) => rest);
  };
  // Ce qui manque, d'après la saisie en cours (même règle que la mise en ligne du mini-site)
  const gaps = bookingOperatorGaps({
    legal_name: v.legalName,
    siret: v.siret,
    address: v.address,
    postal_code: v.postalCode,
    city: v.city,
    vtc_registration: v.vtcRegistration,
  });
  const neededHint = privateFleet ? "Nécessaire pour vos factures." : "Nécessaire pour vos factures et la mise en ligne de votre mini-site.";
  const need = (k: keyof Values) => (NEEDED.includes(k) && !v[k].trim() ? neededHint : undefined);

  const save = () =>
    start(() =>
      runAction(async () => {
        const res = await updateOrganization(v);
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          toast.error(res.error ?? "Enregistrement impossible.");
          return;
        }
        setErrors({});
        setBaseline(v);
        toast.success("Identité de l'entreprise enregistrée");
        router.refresh();
      }),
    );

  const field = (k: keyof Values) => ({
    value: v[k],
    disabled: readOnly,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value),
  });

  return (
    <Card className="max-w-4xl">
      <CardHeader
        title="Identité de votre entreprise"
        description={
          privateFleet
            ? "Affichée dans l'application et sur vos factures."
            : "Affichée dans l'application chauffeur, sur vos factures et sur votre mini-site."
        }
      />
      <CardBody className="space-y-5">
        {gaps.length > 0 && (
          <Callout tone="warning" title={`${plural(gaps.length, "information manquante", "informations manquantes")}`}>
            {readOnly ? "À compléter par un administrateur" : "À compléter"}
            {NB}: {gaps.join(", ")}.
          </Callout>
        )}
        <form onSubmit={submitWith(() => save())} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Nom commercial" error={errors.name} hint="Le nom que voient vos clients et vos chauffeurs.">
            <Input name="name" autoComplete="organization" required maxLength={120} {...field("name")} />
          </Field>
          <Field label="Raison sociale" error={errors.legalName} hint={need("legalName")}>
            <Input name="legalName" autoComplete="off" maxLength={160} placeholder="ex. : Élite Chauffeurs SAS" {...field("legalName")} />
          </Field>
          <Field label="SIRET" error={errors.siret} hint={need("siret") ?? "14 chiffres."}>
            <Input name="siret" inputMode="numeric" autoComplete="off" maxLength={20} placeholder="ex. : 912 345 678 00019" className="num" {...field("siret")} />
          </Field>
          <Field label="E-mail" optional error={errors.email}>
            <Input name="email" type="email" inputMode="email" autoComplete="email" maxLength={254} placeholder="ex. : contact@monsite.fr" {...field("email")} />
          </Field>
          <Field label="Téléphone" optional error={errors.phone}>
            <Input name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={30} placeholder="ex. : 01 84 60 12 12" {...field("phone")} />
          </Field>
          <Field label="Adresse" error={errors.address} hint={need("address")} className="sm:col-span-2">
            <Input name="address" autoComplete="street-address" maxLength={200} placeholder="ex. : 48 avenue Victor Hugo" {...field("address")} />
          </Field>
          <Field label="Code postal" error={errors.postalCode} hint={need("postalCode")}>
            <Input name="postalCode" inputMode="numeric" autoComplete="postal-code" maxLength={12} placeholder="ex. : 75116" className="num" {...field("postalCode")} />
          </Field>
          <Field label="Ville" error={errors.city} hint={need("city")}>
            <Input name="city" autoComplete="address-level2" maxLength={80} placeholder="ex. : Paris" {...field("city")} />
          </Field>
          <Field
            label="Inscription VTC"
            error={errors.vtcRegistration}
            className="sm:col-span-2"
            hint={
              need("vtcRegistration") ??
              (privateFleet
                ? "N° d'inscription au registre des exploitants VTC."
                : "N° d'inscription au registre des exploitants VTC et, si vous prenez des réservations pour d'autres chauffeurs, de déclaration de centrale de réservation. Affiché sur votre mini-site.")
            }
          >
            <Input name="vtcRegistration" autoComplete="off" maxLength={120} placeholder="ex. : EVTC075…" {...field("vtcRegistration")} />
          </Field>
          {!readOnly && (
            <div className="flex flex-wrap items-center justify-end gap-3 sm:col-span-2">
              <p className={cn("text-[12.5px]", dirty ? "text-amber" : "text-fg-muted")} aria-live="polite">
                {dirty ? "Modifications non enregistrées" : ""}
              </p>
              <Button type="submit" variant="primary" loading={pending} disabled={!dirty} className="max-sm:w-full">
                Enregistrer
              </Button>
            </div>
          )}
        </form>
        {!readOnly && <UnsavedGuard dirty={dirty} />}
      </CardBody>
    </Card>
  );
}
