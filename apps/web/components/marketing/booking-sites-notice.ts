/**
 * Mini-sites de réservation coupés pour toute la plateforme (interrupteur du super admin, `bookingSitesEnabled`) :
 * phrase affichée par le site vitrine à la place, ou à la suite, de la présentation du mini-site. Les pages qui
 * l'affichent sont régénérées toutes les 5 minutes au plus (`export const revalidate = 300`) : statiques, sans
 * lecture de la base à chaque visite.
 */
export const BOOKING_SITES_OFF_NOTICE =
  "Le mini-site de réservation est momentanément indisponible pour toutes les centrales. Vos clients peuvent réserver sur votre propre site relié à l'API, ou par téléphone, avec une saisie dans le tableau de bord.";
