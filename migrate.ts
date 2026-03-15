import { Client } from "pg";
import "dotenv/config";

async function run() {
  const connectionString = process.env.DATABASE_URL!.replace(/"/g, "");
  console.log("Connecting via pg...");

  const client = new Client({ connectionString });
  await client.connect();

  console.log("Applying backend-specific tables...");

  await client.query(`
    CREATE TABLE IF NOT EXISTS "rooms" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "org_id" text NOT NULL,
      "name" text NOT NULL,
      "created_by" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "room_members" (
      "room_id" uuid NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL,
      PRIMARY KEY ("room_id", "user_id")
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "offline_queue" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "org_id" text NOT NULL,
      "recipient_id" text NOT NULL,
      "blob" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "archive_blobs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "org_id" text NOT NULL,
      "room_id" uuid NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
      "uploader_id" text NOT NULL,
      "blob" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "supernode_registry" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "org_id" text NOT NULL,
      "user_id" text NOT NULL,
      "device_label" text NOT NULL,
      "is_active" boolean DEFAULT true NOT NULL,
      "on_power" boolean DEFAULT false NOT NULL,
      "storage_mb" integer DEFAULT 0 NOT NULL,
      "last_heartbeat" timestamp with time zone DEFAULT now() NOT NULL,
      "elected" boolean DEFAULT false NOT NULL
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "messages" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "room_id" uuid NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL,
      "content" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);

  console.log("✅ Tables created successfully!");
  await client.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
