"use client";
// Super admin : éditeur et hébergeurs affichés dans les pages légales publiques (mentions légales, confidentialité,
// CGU, CGV, cookies, accord de traitement des données).
import { Building2, Save, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type LegalInfoInput, updateLegalInfo } from "@/app/admin/legal/actions";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

type Values = Record<keyof LegalInfoInput, string>;

const EDITOR: { key: keyof Values; label: string; placeholder?: string; hint?: string; wide?: boolean }[] = [
  { key: "company_name", label: "Raison sociale", placeholder: "Rydar SAS" },
  { key: "legal_form", label: "Forme juridique", placeholder: "SAS" },
  { key: "share_capital", label: "Capital social", placeholder: "1 000 €" },
  { key: "registration", label: "Immatriculation", placeholder: "RCS Paris 912 345 678", hint: "RCS (ville + SIREN) ou n° SIREN." },
  { key: "vat_number", label: "N° de TVA intracommunautaire", placeholder: "FR12 912345678" },
  { key: "publication_director", label: "Directeur de la publication", placeholder: "Prénom Nom" },
  { key: "address", label: "Adresse du siège", placeholder: "12 rue …, 75008 Paris", wide: true },
  { key: "email", label: "E-mail de contact", placeholder: "contact@…" },
  { key: "phone", label: "Téléphone", placeholder: "01 23 45 67 89" },
  { key: "privacy_email", label: "E-mail « données personnelles »", placeholder: "rgpd@…", hint: "Vide : e-mail de contact." },
];
const HOST: typeof EDITOR = [
  { key: "host_name", label: "Hébergeur du serveur", placeholder: "Hetzner Online GmbH", hint: "Société qui loue le VPS." },
  { key: "host_phone", label: "Téléphone de l'hébergeur", placeholder: "+49 9831 505-0" },
  { key: "host_address", label: "Adresse de l'hébergeur", placeholder: "Industriestr. 25, 91710 Gunzenhausen, Allemagne", wide: true },
  { key: "data_host", label: "Hébergeur des données", placeholder: "Supabase (base de données et fichiers, région Union européenne)", wide: true },
];

export function LegalInfoForm({ initial }: { initial: Values }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof Values, value: string) => {
    setV((cur) => ({ ...cur, [k]: value }));
    setErrors(({ [k]: _drop, ...rest }) => rest);
  };
  const save = () =>
    start(() => runAction(async () => {
      const res = await updateLegalInfo(v);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        return void toast.error(res.error);
      }
      toast.success("Informations légales enregistrées");
      router.refresh();
    }));

  const fields = (list: typeof EDITOR) => (
    <div className="grid gap-4 sm:grid-cols-2">
      {list.map((f) => (
        <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]} className={f.wide ? "sm:col-span-2" : undefined}>
          <Input value={v[f.key]} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} aria-invalid={!!errors[f.key]} />
        </Field>
      ))}
    </div>
  );

  return (
    <form onSubmit={submitWith(save)} className="space-y-6">
      <Card>
        <CardHeader icon={<Building2 />} title="Éditeur" description="Mentions légales (LCEN), contact pour les données personnelles, CGU et CGV." />
        <CardBody>{fields(EDITOR)}</CardBody>
      </Card>
      <Card>
        <CardHeader icon={<Server />} title="Hébergement" description="Hébergeur du site (obligatoire dans les mentions légales) et des données." />
        <CardBody>{fields(HOST)}</CardBody>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={pending}>
          <Save /> Enregistrer
        </Button>
      </div>
    </form>
  );
}
