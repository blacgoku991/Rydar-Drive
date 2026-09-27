import { NextResponse } from "next/server";

// /.well-known/assetlinks.json (réécriture dans next.config) : liens d'application Android vérifiés.
// Les liens https://DOMAINE/rejoindre/{code} ouvrent l'application chauffeur quand elle est installée.
// ANDROID_CERT_SHA256 : empreinte(s) SHA-256 du certificat de signature (Play Console › Intégrité de
// l'application › Signature d'application), séparées par des virgules ; ANDROID_APP_PACKAGE (défaut app.rydar.driver).
export const dynamic = "force-dynamic";

export function GET() {
  const fingerprints = (process.env.ANDROID_CERT_SHA256 || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!fingerprints.length) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: process.env.ANDROID_APP_PACKAGE || "app.rydar.driver", sha256_cert_fingerprints: fingerprints },
      },
    ],
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
