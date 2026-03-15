import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  archiveBlobs,
  offlineQueue,
} from "../db/schema.ts";
import { resolveAuthContext, ROLE_LEVELS } from "../middleware/auth.ts";
import { disconnectOrg } from "../ws/connections.ts";

export const panicRoutes = new Elysia({ prefix: "/api/v1" })
  .resolve(resolveAuthContext)

  // ── POST /panic (admin+ only) ──────────────────────────
  // Atomic wipe of all org data managed by this backend.
  // Does NOT delete the Better Auth organization record (that 
  // stays intact for the frontend workspace selector).
  .post("/panic", async ({ user }) => {
    if (user.roleLevel < ROLE_LEVELS.admin) {
      throw new Response("Admin required", { status: 403 });
    }

    const orgId = user.orgId;

    // 1. Broadcast panic:wipe and disconnect all WS clients
    disconnectOrg(orgId);

    // 2. Delete all archive_blobs for org
    await db
      .delete(archiveBlobs)
      .where(eq(archiveBlobs.orgId, orgId));

    // 3. Delete all offline_queue for org
    await db
      .delete(offlineQueue)
      .where(eq(offlineQueue.orgId, orgId));

    return { success: true, wiped: orgId };
  });
