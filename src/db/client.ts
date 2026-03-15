import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

const globalForDb = globalThis as {
  __nexusPgPool?: Pool;
};

const pool =
  globalForDb.__nexusPgPool ??
  new Pool({
    connectionString: config.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

if (!globalForDb.__nexusPgPool) {
  globalForDb.__nexusPgPool = pool;
}

export const db = drizzle(pool, { schema });
