"use client";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META, type VehicleCategory } from "@rydar/shared";
import { ExternalLink, Globe, RefreshCw, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateBookingSite, verifyCustomDomain } from "@/app/dashboard/booking-site/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
import { cn } from "@/lib/utils";

/**
 * Contraste de la couleur principale sur le fond du mini-site (ink-950, #060709) : texte et repères colorés lisibles
 * à partir de 4,5:1 (WCAG 1.4.3). null : couleur illisible (saisie en cours).
 */
export function brandContrastOnDark(hex: string): number | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const lum = (h: string) => {
    const n = parseInt(h.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [a, b] = [lum(hex), lum("#060709")].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

export function BookingSiteForm({ site, slug, rootDomain, appUrl, token, canEdit, planAllows, customDomainAllowed }: { site: any; slug: string; rootDomain: string; appUrl: string; token: string; canEdit: boolean; planAllows: boolean; customDomainAllowed: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [s, setS] = useState({ ...site, email: site.email ?? "", custom_domain: site.custom_domain ?? "" });
  const [frameKey, setFrameKey] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: string, v: unknown) => setS((c: any) => ({ ...c, [k]: v }));
  const publicUrl = s.custom_domain_verified_at && s.custom_domain ? `https://${s.custom_domain}` : `https://${s.subdomain ?? slug}.${rootDomain}`;
  const previewUrl = `${appUrl}/book/${slug}?preview=1`;

  const save = () =>
    start(() => runAction(async () => {
      const res = await updateBookingSite({
        enabled: s.enabled, subdomain: s.subdomain || null, custom_domain: s.custom_domain || null, title: s.title ?? "", tagline: s.tagline ?? "",
        description: s.description ?? "", logo_url: s.logo_url ?? "", hero_image_url: s.hero_image_url ?? "", primary_color: s.primary_color,
        phone: s.phone ?? "", email: s.email ?? "", whatsapp: s.whatsapp ?? "", service_area: s.service_area ?? "",
        vehicle_categories: s.vehicle_categories, show_price_estimate: s.show_price_estimate, legal_mentions: s.legal_mentions ?? "",
      });
      setErrors(res.ok ? {} : (res.fieldErrors ?? {}));
      if (!res.ok) return void toast.error(res.error);
      toast.success("Mini-site enregistré");
      setFrameKey((k) => k + 1);
      router.refresh();
    }));

  return (
    <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-6">
        {!planAllows && <div className="rounded-xl border border-amber/30 bg-amber/[0.06] px-4 py-3 text-[13px] text-amber">Le mini-site est disponible à partir de l&apos;offre Pro.</div>}
        <Card>
          <CardHeader
            title="Publication"
            icon={<Globe />}
            description={s.enabled ? publicUrl : "Le mini-site n'est pas en ligne."}
            action={<Switch aria-label="Mini-site en ligne" checked={s.enabled} disabled={!canEdit || !planAllows} onCheckedChange={(v) => set("enabled", v)} />}
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Sous-domaine" hint={`${s.subdomain || slug}.${rootDomain}`}>
              <Input value={s.subdomain ?? ""} onChange={(e) => set("subdomain", e.target.value.toLowerCase())} disabled={!canEdit} />
            </Field>
            <Field label="Domaine personnalisé" optional hint={customDomainAllowed ? "ex. reservation.ma-centrale.fr" : "Offre Business"}>
              <div className="flex gap-2">
                <Input value={s.custom_domain} onChange={(e) => set("custom_domain", e.target.value.toLowerCase())} disabled={!canEdit || !customDomainAllowed} />
                {site.custom_domain &&
                  (site.custom_domain_verified_at ? (
                    <Badge tone="green" className="h-10 rounded-lg">Vérifié</Badge>
                  ) : customDomainAllowed ? (
                    <Badge tone="amber" className="h-10 rounded-lg">À vérifier</Badge>
                  ) : (
                    <Badge tone="neutral" className="h-10 rounded-lg">Hors offre</Badge>
                  ))}
              </div>
            </Field>
            {/* Domaine retiré par l'offre : plus de vérification possible (l'action la refuse aussi) */}
            {site.custom_domain && !site.custom_domain_verified_at && customDomainAllowed && (
              <div className="space-y-2 rounded-xl border border-line bg-white/[0.02] p-4 text-[12.5px] text-fg-muted sm:col-span-2">
                <p className="font-medium text-fg">Configuration DNS</p>
                <p>1. <span className="num text-fg">CNAME {site.custom_domain} → cname.{rootDomain}</span></p>
                <p>2. <span className="num text-fg">TXT _rydar.{site.custom_domain} = {token}</span></p>
                <Button size="sm" variant="secondary" loading={pending} onClick={() => start(() => runAction(async () => { const r = await verifyCustomDomain(); if (r.ok) { toast.success("Domaine vérifié"); router.refresh(); } else toast.error(r.error); }))}>
                  <ShieldCheck /> Vérifier maintenant
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Contenu & identité" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Nom affiché"><Input value={s.title ?? ""} onChange={(e) => set("title", e.target.value)} disabled={!canEdit} /></Field>
            <Field
              label="Couleur principale"
              hint={
                (brandContrastOnDark(s.primary_color) ?? 21) < 4.5
                  ? `Couleur trop sombre sur le fond du mini-site (contraste ${(brandContrastOnDark(s.primary_color) ?? 0).toFixed(1).replace(".", ",")}:1, 4,5:1 au moins) : certains textes seraient peu lisibles, choisissez une teinte plus claire.`
                  : undefined
              }
            >
              <div className="flex gap-2">
                <input type="color" value={s.primary_color} onChange={(e) => set("primary_color", e.target.value.toUpperCase())} disabled={!canEdit} className="h-10 w-12 cursor-pointer rounded-lg border border-line-strong bg-ink-850 p-1" />
                <Input value={s.primary_color} onChange={(e) => set("primary_color", e.target.value)} className="num" disabled={!canEdit} aria-label="Couleur principale, code hexadécimal" />
              </div>
            </Field>
            <Field label="Accroche" className="sm:col-span-2"><Input value={s.tagline ?? ""} onChange={(e) => set("tagline", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Description" className="sm:col-span-2"><Textarea value={s.description ?? ""} onChange={(e) => set("description", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Logo (URL)" optional error={errors.logo_url} hint="Affiché seulement s'il est hébergé par Rydar Drive : une image d'un autre site n'est jamais chargée (elle transmettrait l'adresse IP de vos visiteurs à ce site)."><Input value={s.logo_url ?? ""} onChange={(e) => set("logo_url", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Photo de fond (URL)" optional error={errors.hero_image_url} hint="Même règle que le logo."><Input value={s.hero_image_url ?? ""} onChange={(e) => set("hero_image_url", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Téléphone" error={errors.phone} hint="Obligatoire pour mettre le mini-site en ligne."><Input value={s.phone ?? ""} onChange={(e) => set("phone", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="E-mail" error={errors.email} hint="Obligatoire pour mettre le mini-site en ligne."><Input value={s.email ?? ""} onChange={(e) => set("email", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Zone couverte" className="sm:col-span-2"><Input value={s.service_area ?? ""} onChange={(e) => set("service_area", e.target.value)} disabled={!canEdit} /></Field>
            <div className="sm:col-span-2">
              <p className="mb-2 text-[12.5px] font-medium text-fg-muted">Catégories proposées</p>
              <div className="flex flex-wrap gap-2">
                {VEHICLE_CATEGORIES.map((c) => {
                  const on = s.vehicle_categories.includes(c);
                  return (
                    <button key={c} type="button" aria-pressed={on} disabled={!canEdit} onClick={() => set("vehicle_categories", on ? s.vehicle_categories.filter((x: VehicleCategory) => x !== c) : [...s.vehicle_categories, c])} className={cn("rounded-lg border px-3 py-1.5 text-[12.5px]", on ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted")}>
                      {VEHICLE_CATEGORY_META[c].label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-3 sm:col-span-2">
              <span>
                <span className="block text-[13px]">Afficher le prix avant la réservation (grille tarifaire, montants toutes taxes comprises)</span>
                <span className="block text-[12px] text-fg-subtle">
                  Le client réserve à ce prix, « avec obligation de paiement ». Désactivé : il envoie une demande sans prix, que vous lui confirmez.
                </span>
              </span>
              <Switch checked={s.show_price_estimate} onCheckedChange={(v) => set("show_price_estimate", v)} disabled={!canEdit} />
            </label>
            <Field
              label="Conditions pour vos clients"
              className="sm:col-span-2"
              error={errors.legal_mentions}
              hint="Obligatoires pour mettre le mini-site en ligne (40 caractères au moins), affichées en tête du formulaire de réservation. Pour des clients particuliers : votre identité (raison sociale, adresse, immatriculation), conditions de réservation et d'annulation, moyens de paiement acceptés, et nom et site web de votre médiateur de la consommation (Code de la consommation, articles L111-1, L221-5, L221-14 et L612-1). Rydar ne les rédige pas pour vous."
            >
              <Textarea value={s.legal_mentions ?? ""} onChange={(e) => set("legal_mentions", e.target.value)} disabled={!canEdit} maxLength={2000} />
            </Field>
            {canEdit && <div className="flex justify-end sm:col-span-2"><Button variant="primary" loading={pending} onClick={save}>Enregistrer</Button></div>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Intégrer sur un site existant" description="Le formulaire peut aussi s'afficher dans une page de votre site." />
          <CardBody>
            <CodeBlock language="html" code={`<iframe src="${appUrl}/book/${slug}" style="width:100%;min-height:980px;border:0;border-radius:24px" title="Réservation"></iframe>`} />
          </CardBody>
        </Card>
      </div>
      <Card className="overflow-hidden 2xl:sticky 2xl:top-6 2xl:h-[calc(100dvh-48px)]">
        <CardHeader
          title="Aperçu"
          description="Rendu réel du mini-site"
          action={
            <div className="flex gap-1">
              <Button size="icon-sm" variant="ghost" onClick={() => setFrameKey((k) => k + 1)} aria-label="Rafraîchir l'aperçu"><RefreshCw /></Button>
              <Button asChild size="icon-sm" variant="ghost"><a href={previewUrl} target="_blank" rel="noreferrer" aria-label="Ouvrir le mini-site (nouvel onglet)"><ExternalLink /></a></Button>
            </div>
          }
        />
        <iframe key={frameKey} src={previewUrl} title="Aperçu du mini-site" className="h-[760px] w-full bg-ink-950 2xl:h-[calc(100%-73px)]" />
      </Card>
    </div>
  );
}
