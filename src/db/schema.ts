import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";

// ── Enums ──────────────────────────────────────────────
export const roleEnum = pgEnum("role", [
  "owner",
  "admin",
  "manager",
  "member",
  "guest",
]);

// ══════════════════════════════════════════════════════════
//  Better Auth tables (read-only references)
//  These mirror the tables created by `bunx auth migrate`
//  in the shared Neon database. The backend reads from them
//  to validate sessions and resolve user/org identity.
// ══════════════════════════════════════════════════════════

/** Better Auth — user table */
export const baUser = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
});

/** Better Auth — session table */
export const baSession = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => baUser.id, { onDelete: "cascade" }),
  activeOrganizationId: text("activeOrganizationId"),
});

/** Better Auth — organization table */
export const baOrganization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  metadata: text("metadata"),
});

/** Better Auth — member table (org membership) */
export const baMember = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => baOrganization.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => baUser.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
});

// ══════════════════════════════════════════════════════════
//  App-specific tables (owned by this backend)
//  Foreign keys reference Better Auth's user/org IDs.
// ══════════════════════════════════════════════════════════

// ── Rooms ──────────────────────────────────────────────
export const rooms = pgTable("rooms", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),   // references baOrganization.id
  name: text("name").notNull(),
  createdBy: text("created_by").notNull(), // references baUser.id
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── Room Members ───────────────────────────────────────
export const roomMembers = pgTable(
  "room_members",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // references baUser.id
  },
  (table) => [primaryKey({ columns: [table.roomId, table.userId] })]
);

// ── Offline Queue ──────────────────────────────────────
export const offlineQueue = pgTable("offline_queue", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  recipientId: text("recipient_id").notNull(),
  blob: text("blob").notNull(), // base64 encrypted, server cannot decrypt
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── Archive Blobs ──────────────────────────────────────
export const archiveBlobs = pgTable("archive_blobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id").notNull(),
  blob: text("blob").notNull(), // base64 encrypted
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── SuperNode Registry ─────────────────────────────────
export const supernodeRegistry = pgTable("supernode_registry", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  deviceLabel: text("device_label").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  onPower: boolean("on_power").notNull().default(false),
  storageMb: integer("storage_mb").notNull().default(0),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true })
    .notNull()
    .defaultNow(),
  elected: boolean("elected").notNull().default(false),
});

// ── Messages ───────────────────────────────────────
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(), // references baUser.id
  content: text("content").notNull(), // HTML content
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
