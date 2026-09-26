import { NextResponse } from "next/server";

// /.well-known/apple-app-site-association (réécriture dans next.config) : liens universels iOS.
// Les liens https://DOMAINE/rejoindre/{code} ouvrent l'application chauffeur quand elle est installée.
// APPLE_APP_IDS : « TEAMID.bundle.id », plusieurs séparés par des virgules.
export const dynamic = "force-dynamic";

export function GET() {
  const appIDs = (process.env.APPLE_APP_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!appIDs.length) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(
    { applinks: { details: [{ appIDs, components: [{ "/": "/rejoindre/*", comment: "Inscription chauffeur par le lien d'une centrale" }] }] } },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
