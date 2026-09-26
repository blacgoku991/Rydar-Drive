// Routes appelées par l'application chauffeur : l'app mobile n'est pas concernée par le CORS ; seules les
// origines listées dans DRIVER_APP_ORIGINS (aperçu web de l'app, ex. http://localhost:8081) sont autorisées.
export function driverAppCors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = (process.env.DRIVER_APP_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
}
