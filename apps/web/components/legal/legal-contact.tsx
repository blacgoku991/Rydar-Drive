import Link from "next/link";

const link = "text-fg underline underline-offset-2";

/**
 * Moyen de joindre l'éditeur dans les pages légales : l'e-mail de /admin/legal s'il est renseigné, et toujours le
 * formulaire de contact (/contact, qui fonctionne même sans e-mail) ; jamais un renvoi vers des mentions légales
 * encore « à compléter », qui ne laisserait aucun moyen de contact.
 *  - `noun` : après « : » (« contact@… ou le formulaire de contact ») ;
 *  - `to` : après un verbe construit avec « à » (« écrivez à contact@… ou par le formulaire de contact »,
 *    « écrivez à l'éditeur par le formulaire de contact »).
 */
export function legalContact(email: string) {
  const form = (
    <Link href="/contact" className={link}>
      formulaire de contact
    </Link>
  );
  const mail = email ? (
    <a href={`mailto:${email}`} className={link}>
      {email}
    </a>
  ) : null;
  return {
    noun: mail ? <>{mail} ou le {form}</> : <>le {form}</>,
    to: mail ? <>à {mail} ou par le {form}</> : <>à l&apos;éditeur par le {form}</>,
  };
}
