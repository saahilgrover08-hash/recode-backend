import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { offlineQueue } from "../db/schema.ts";
import { resolveAuthContext } from "../middleware/auth.ts";

export const queueRoutes = new Elysia({ prefix: "/api/v1/queue" })
  .resolve(resolveAuthContext)

  // ── GET /queue/pending ─────────────────────────────────
  // Fetch all offline blobs for current user, auto-delete after response
  .get("/pending", async ({ user }) => {
    const blobs = await db
      .select({
        id: offlineQueue.id,
        blob: offlineQueue.blob,
        createdAt: offlineQueue.createdAt,
      })
      .from(offlineQueue)
      .where(eq(offlineQueue.recipientId, user.id));

    if (blobs.length > 0) {
      // Delete all fetched blobs
      const blobIds = blobs.map((b) => b.id);
      for (const id of blobIds) {
        await db.delete(offlineQueue).where(eq(offlineQueue.id, id));
      }
    }

    return { blobs };
  });
