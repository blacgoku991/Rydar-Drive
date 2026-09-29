import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "pg-connection-string";
import { describe, expect, it } from "vitest";
import { dbTlsHint, dbUrlHost, isLocalDbHost, withSslMode } from "./config";

// Racine publique Supabase versionnée (deploy/supabase-ca.crt), montée dans le worker par deploy/docker-compose.yml
const CA_FILE = fileURLToPath(new URL("../../../deploy/supabase-ca.crt", import.meta.url));
const POOLER = "postgresql://postgres.abcd:p%40ss%3Aw0rd@aws-0-eu-west-3.pooler.supabase.com:5432/postgres";

describe("worker — connexion chiffrée à la base (DATABASE_SSLMODE)", () => {
  it("sans DATABASE_SSLMODE : chaîne inchangée (développement, docker run générique)", () => {
    expect(withSslMode(`${POOLER}?sslmode=no-verify`, "")).toBe(`${POOLER}?sslmode=no-verify`);
    expect(withSslMode(POOLER, undefined, CA_FILE)).toBe(POOLER);
  });

  it("verify-full : remplace le no-verify de l'ancienne chaîne, ajoute la racine, garde le reste", () => {
    const url = withSslMode(`${POOLER}?application_name=x&sslmode=no-verify&sslrootcert=/ancien.crt`, "verify-full", "/etc/rydar/supabase-ca.crt");
    expect(url).toBe(`${POOLER}?application_name=x&sslmode=verify-full&sslrootcert=%2Fetc%2Frydar%2Fsupabase-ca.crt`);
    expect(withSslMode(POOLER, " verify-full ", "/ca.crt")).toBe(`${POOLER}?sslmode=verify-full&sslrootcert=%2Fca.crt`);
  });

  it("pilote pg : verify-full vérifie le certificat avec la racine Supabase ; no-verify (repli) ne le vérifie pas", () => {
    const strict = parse(withSslMode(`${POOLER}?sslmode=no-verify`, "verify-full", CA_FILE));
    expect(strict.password).toBe("p@ss:w0rd");
    expect(strict.ssl).toMatchObject({ ca: readFileSync(CA_FILE, "utf8") });
    expect((strict.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized).not.toBe(false);

    const legacy = parse(withSslMode(`${POOLER}?sslmode=verify-full&sslrootcert=${encodeURIComponent(CA_FILE)}`, "no-verify", CA_FILE));
    expect(legacy.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("valeur inconnue refusée au démarrage (jamais de repli silencieux)", () => {
    expect(() => withSslMode(POOLER, "require")).toThrow(/DATABASE_SSLMODE invalide/);
    expect(() => withSslMode(POOLER, "prefer")).toThrow(/verify-full, no-verify ou disable/);
  });

  it("disable (Supabase auto-hébergé) : sans chiffrement pour une base locale seulement, refusé pour une base distante", () => {
    const local = "postgresql://postgres:p%40ss@127.0.0.1:5432/postgres";
    const url = withSslMode(`${local}?sslmode=no-verify&sslrootcert=/ancien.crt`, "disable", CA_FILE);
    expect(url).toBe(`${local}?sslmode=disable`);
    const cfg = parse(url);
    expect(cfg.ssl).toBe(false);
    expect(cfg.password).toBe("p@ss");
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "supavisor", "supabase-db", "DB"]) {
      expect(() => withSslMode(`postgresql://postgres:x@${host}:5432/postgres`, "disable"), host).not.toThrow();
    }
    for (const host of ["aws-0-eu-west-3.pooler.supabase.com", "db.abcd.supabase.co", "api.rydardrive.com", "146.59.153.211", "172.32.0.1", "172.15.0.1", "192.169.0.1", "8.8.8.8", "999.0.0.1", "host.docker.internal", "[2001:db8::1]"]) {
      expect(() => withSslMode(`postgresql://postgres:x@${host}:5432/postgres`, "disable"), host).toThrow(/base distante/);
    }
    expect(() => withSslMode(POOLER, "disable")).toThrow(/base distante/);
    // Chaîne illisible : jamais considérée comme locale
    expect(() => withSslMode("pas-une-url", "disable")).toThrow(/base distante/);
  });

  it("hôte d'une chaîne de connexion et règle « base locale »", () => {
    expect(dbUrlHost(POOLER)).toBe("aws-0-eu-west-3.pooler.supabase.com");
    expect(dbUrlHost("postgresql://postgres@[::1]:5432/db")).toBe("::1");
    expect(dbUrlHost("postgres://u:p@Supavisor:6543/postgres?x=1")).toBe("supavisor");
    expect(isLocalDbHost("")).toBe(false);
    expect(isLocalDbHost("127.0.0.1")).toBe(true);
    expect(isLocalDbHost("rydardrive.com")).toBe(false);
  });

  it("certificat versionné = racine officielle Supabase 2021 (empreinte SHA-256)", () => {
    const cert = new X509Certificate(readFileSync(CA_FILE));
    expect(cert.subject).toContain("CN=Supabase Root 2021 CA");
    expect(cert.ca).toBe(true);
    expect(cert.fingerprint256).toBe("80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
  });

  it("journal : indication de repli seulement pour une erreur de certificat", () => {
    expect(dbTlsHint(new Error("self-signed certificate in certificate chain")).hint).toMatch(/DEPLOYMENT\.md/);
    expect(dbTlsHint(new Error("Hostname/IP does not match certificate's altnames")).hint).toBeDefined();
    expect(dbTlsHint(new Error("password authentication failed for user \"postgres\"")).hint).toBeUndefined();
  });
});
