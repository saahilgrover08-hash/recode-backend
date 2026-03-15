import { Elysia, t } from "elysia";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.ts";
import { archiveBlobs, roomMembers } from "../db/schema.ts";
import { resolveAuthContext } from "../middleware/auth.ts";

export const archiveRoutes = new Elysia({ prefix: "/api/v1/archive" })
  .resolve(resolveAuthContext)

  // ── POST /archive/upload ───────────────────────────────
  .post(
    "/upload",
    async ({ user, body }) => {
      // Verify user is member of the room
      const [membership] = await db
        .select()
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, body.roomId),
            eq(roomMembers.userId, user.id)
          )
        )
        .limit(1);

      if (!membership) {
        throw new Response("Not a member of this room", { status: 403 });
      }

      const [blob] = await db
        .insert(archiveBlobs)
        .values({
          orgId: user.orgId,
          roomId: body.roomId,
          uploaderId: user.id,
          blob: body.blob,
        })
        .returning();

      if (!blob) {
        throw new Response("Failed to upload archive blob", { status: 500 });
      }

      return { id: blob.id, createdAt: blob.createdAt };
    },
    {
      body: t.Object({
        roomId: t.String({ format: "uuid" }),
        blob: t.String({ minLength: 1 }), // base64 encrypted
      }),
    }
  )

  // ── GET /archive/:roomId (paginated) ───────────────────
  .get(
    "/:roomId",
    async ({ user, params, query }) => {
      // Verify user is member of the room
      const [membership] = await db
        .select()
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, params.roomId),
            eq(roomMembers.userId, user.id)
          )
        )
        .limit(1);

      if (!membership) {
        throw new Response("Not a member of this room", { status: 403 });
      }

      const page = Number(query.page ?? 1);
      const limit = Math.min(Number(query.limit ?? 50), 100);
      const offset = (page - 1) * limit;

      const blobs = await db
        .select({
          id: archiveBlobs.id,
          uploaderId: archiveBlobs.uploaderId,
          blob: archiveBlobs.blob,
          createdAt: archiveBlobs.createdAt,
        })
        .from(archiveBlobs)
        .where(
          and(
            eq(archiveBlobs.roomId, params.roomId),
            eq(archiveBlobs.orgId, user.orgId)
          )
        )
        .orderBy(desc(archiveBlobs.createdAt))
        .limit(limit)
        .offset(offset);

      return { page, limit, blobs };
    },
    {
      params: t.Object({
        roomId: t.String({ format: "uuid" }),
      }),
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    }
  );
