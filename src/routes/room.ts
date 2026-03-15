import { Elysia, t } from "elysia";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  rooms,
  roomMembers,
  archiveBlobs,
  baUser,
  messages,
  baMember,
} from "../db/schema.ts";
import { resolveAuthContext, ROLE_LEVELS } from "../middleware/auth.ts";
import { broadcastToOrg } from "../ws/connections.ts";

async function syncUserIntoWorkspaceRooms(userId: string, orgId: string) {
  const orgRooms = await db
    .select({ roomId: rooms.id })
    .from(rooms)
    .where(eq(rooms.orgId, orgId));

  if (orgRooms.length === 0) return;

  await db
    .insert(roomMembers)
    .values(orgRooms.map((room) => ({ roomId: room.roomId, userId })))
    .onConflictDoNothing();
}

async function syncWorkspaceMembersIntoRoom(roomId: string, orgId: string) {
  const orgMembers = await db
    .select({ userId: baMember.userId })
    .from(baMember)
    .where(eq(baMember.organizationId, orgId));

  if (orgMembers.length === 0) return;

  await db
    .insert(roomMembers)
    .values(orgMembers.map((member) => ({ roomId, userId: member.userId })))
    .onConflictDoNothing();
}

async function ensureUserCanAccessRoom(
  roomId: string,
  userId: string,
  orgId: string
) {
  const [room] = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.id, roomId), eq(rooms.orgId, orgId)))
    .limit(1);

  if (!room) {
    throw new Response("Room not found", { status: 404 });
  }

  await db
    .insert(roomMembers)
    .values({
      roomId: room.id,
      userId,
    })
    .onConflictDoNothing();

  return room;
}

export const roomRoutes = new Elysia({ prefix: "/api/v1/room" })
  .resolve(resolveAuthContext)

  // ── GET /room/:id/messages ─────────────────────────────
  .get(
    "/:id/messages",
    async (ctx) => {
      const user = ctx.user;

      await ensureUserCanAccessRoom(ctx.params.id, user.id, user.orgId);

      // Fetch last 50 messages
      const roomMessages = await db
        .select({
          id: messages.id,
          roomId: messages.roomId,
          userId: messages.userId,
          content: messages.content,
          createdAt: messages.createdAt,
          authorName: baUser.name,
        })
        .from(messages)
        .leftJoin(baUser, eq(messages.userId, baUser.id))
        .where(eq(messages.roomId, ctx.params.id))
        .orderBy(desc(messages.createdAt))
        .limit(50);
        
      // Reverse to chronological order
      return roomMessages.reverse();
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
      }),
    }
  )

  .post(
    "/:id/messages",
    async (ctx) => {
      const user = ctx.user;
      if (user.roleLevel < ROLE_LEVELS.member) {
        throw new Response("Guests cannot send messages", { status: 403 });
      }

      await ensureUserCanAccessRoom(ctx.params.id, user.id, user.orgId);

      const trimmedContent = ctx.body.content.trim();
      if (!trimmedContent) {
        throw new Response("Message content is required", { status: 400 });
      }

      const [newMessage] = await db
        .insert(messages)
        .values({
          roomId: ctx.params.id,
          userId: user.id,
          content: trimmedContent,
        })
        .returning();

      if (!newMessage) {
        throw new Response("Failed to persist message", { status: 500 });
      }

      broadcastToOrg(
        user.orgId,
        "room:message",
        {
          id: newMessage.id,
          room_id: ctx.params.id,
          user_id: user.id,
          author_name: user.name,
          content: trimmedContent,
          timestamp: newMessage.createdAt.toISOString(),
        },
        user.id
      );

      return {
        id: newMessage.id,
        roomId: newMessage.roomId,
        userId: newMessage.userId,
        content: newMessage.content,
        createdAt: newMessage.createdAt,
        authorName: user.name,
      };
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
      }),
      body: t.Object({
        content: t.String({ minLength: 1 }),
      }),
    }
  )

  // ── POST /room/create (admin/manager) ──────────────────
  .post(
    "/create",
    async (ctx) => {
      const user = ctx.user;
      if (user.roleLevel < ROLE_LEVELS.manager) {
        throw new Response("Manager or above required", { status: 403 });
      }

      const [room] = await db
        .insert(rooms)
        .values({
          orgId: user.orgId,
          name: ctx.body.name,
          createdBy: user.id,
        })
        .returning();

      if (!room) throw new Response("Failed to create room", { status: 500 });

      // Rooms behave like workspace channels, so seed all current members.
      await syncWorkspaceMembersIntoRoom(room.id, user.orgId);

      return room;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
      }),
    }
  )

  // ── GET /room/list ─────────────────────────────────────
  .get("/list", async (ctx) => {
    const user = ctx.user;
    await syncUserIntoWorkspaceRooms(user.id, user.orgId);

    const memberRooms = await db
      .select({
        id: rooms.id,
        name: rooms.name,
        createdBy: rooms.createdBy,
        createdAt: rooms.createdAt,
      })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(
        and(
          eq(roomMembers.userId, user.id),
          eq(rooms.orgId, user.orgId)
        )
      );

    return memberRooms;
  })

  // ── POST /room/add-member (admin/manager) ──────────────
  .post(
    "/add-member",
    async (ctx) => {
      const user = ctx.user;
      if (user.roleLevel < ROLE_LEVELS.manager) {
        throw new Response("Manager or above required", { status: 403 });
      }

      // Verify room belongs to org
      const [room] = await db
        .select()
        .from(rooms)
        .where(
          and(eq(rooms.id, ctx.body.roomId), eq(rooms.orgId, user.orgId))
        )
        .limit(1);

      if (!room) {
        throw new Response("Room not found", { status: 404 });
      }

      // Verify target user exists
      const [targetUser] = await db
        .select()
        .from(baUser)
        .where(eq(baUser.id, ctx.body.userId))
        .limit(1);

      if (!targetUser) {
        throw new Response("User not found", { status: 404 });
      }

      const [targetMembership] = await db
        .select({ id: baMember.id })
        .from(baMember)
        .where(
          and(
            eq(baMember.userId, ctx.body.userId),
            eq(baMember.organizationId, user.orgId)
          )
        )
        .limit(1);

      if (!targetMembership) {
        throw new Response("User is not a member of this workspace", {
          status: 400,
        });
      }

      // Insert (ignore if already member)
      await db
        .insert(roomMembers)
        .values({ roomId: ctx.body.roomId, userId: ctx.body.userId })
        .onConflictDoNothing();

      return { success: true, roomId: ctx.body.roomId, userId: ctx.body.userId };
    },
    {
      body: t.Object({
        roomId: t.String({ format: "uuid" }),
        userId: t.String({ minLength: 1 }),
      }),
    }
  )

  // ── DELETE /room/:id (admin only) ──────────────────────
  .delete(
    "/:id",
    async (ctx) => {
      const user = ctx.user;
      if (user.roleLevel < ROLE_LEVELS.admin) {
        throw new Response("Admin required", { status: 403 });
      }

      // Verify room belongs to org
      const [room] = await db
        .select()
        .from(rooms)
        .where(
          and(eq(rooms.id, ctx.params.id), eq(rooms.orgId, user.orgId))
        )
        .limit(1);

      if (!room) {
        throw new Response("Room not found", { status: 404 });
      }

      // Delete all archive blobs for room
      await db
        .delete(archiveBlobs)
        .where(eq(archiveBlobs.roomId, ctx.params.id));

      // Delete room (cascades room_members)
      await db.delete(rooms).where(eq(rooms.id, ctx.params.id));

      return { success: true, deletedRoomId: ctx.params.id };
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
      }),
    }
  );
