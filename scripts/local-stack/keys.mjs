// Génère les clés anon / service_role (JWT HS256) de la stack locale.
import { createHmac } from "node:crypto";

export const JWT_SECRET = process.env.LOCAL_JWT_SECRET ?? "rydar-local-dev-jwt-secret-change-me-0123456789abcdef";

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
export function sign(payload, secret = JWT_SECRET) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const iat = 1758700000;
export const ANON_KEY = sign({ iss: "supabase-local", role: "anon", iat, exp: iat + 10 * 365 * 86400 });
export const SERVICE_KEY = sign({ iss: "supabase-local", role: "service_role", iat, exp: iat + 10 * 365 * 86400 });

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`);
  console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}`);
}
