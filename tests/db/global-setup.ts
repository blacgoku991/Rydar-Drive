import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const DB_NAME = process.env.TEST_DATABASE_NAME ?? "rydar_test";
const root = join(__dirname, "..", "..");

/** Recrée une base vierge : stubs Supabase + toutes les migrations. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  process.env.TEST_DATABASE_URL = url.toString();

  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query("set client_min_messages = warning");
  await db.query(readFileSync(join(root, "scripts/sql/local-supabase-stubs.sql"), "utf8"));
  const dir = join(root, "supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await db.query(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} en échec : ${(error as Error).message}`);
    }
  }
  await db.end();
}
