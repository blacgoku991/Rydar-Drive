import "server-only";
import { headers } from "next/headers";

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0"
  );
}

export async function userAgent(): Promise<string> {
  return (await headers()).get("user-agent")?.slice(0, 300) ?? "";
}
