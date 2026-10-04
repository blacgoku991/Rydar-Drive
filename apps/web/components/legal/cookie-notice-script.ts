// Bandeau cookies rendu avec la page (affiché dès le premier affichage, au lieu d'arriver après le chargement du
// JavaScript) : ce script de <head> (app/layout.tsx) le masque AVANT la première peinture quand il a déjà été fermé
// (stockage local) ou que le stockage est indisponible (même règle que useNotice). Règle CSS : app/globals.css.
// Module sans « use client » : le layout (composant serveur) lit la vraie valeur, pas une référence client.
export const COOKIE_NOTICE_KEY = "rd_cookie_notice";

export const COOKIE_NOTICE_SCRIPT = `try{if(localStorage.getItem("${COOKIE_NOTICE_KEY}")==="1")document.documentElement.dataset.cookieNotice="closed"}catch(e){document.documentElement.dataset.cookieNotice="closed"}`;
