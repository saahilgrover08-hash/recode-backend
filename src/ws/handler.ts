import { Elysia, t } from "elysia";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  baUser,
  baSession,
  baMember,
  offlineQueue,
  supernodeRegistry,
  messages,
  roomMembers,
  rooms,
} from "../db/schema.ts";
import { ROLE_LEVELS, type RoleName } from "../middleware/auth.ts";
import {
  registerConnection,
  removeConnection,
  getConnection,
  broadcastToOrg,
  isOnline,
} from "./connections.ts";
import {
  resolveSessionToken,
  resolveSessionTokenFromCookieHeader,
} from "../auth/session-token.ts";

type WsUser = {
  userId: string;
  orgId: string;
  role: RoleName;
  displayName: string;
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Store authenticated user data per WebSocket
const wsUserMap = new Map<any, WsUser>();

function getCookieHeaderFromWs(ws: any): string | null {
  const req = ws?.data?.request;
  if (req?.headers?.get) return req.headers.get("cookie");

  const headers = ws?.data?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get("cookie");
  if (typeof headers.cookie === "string") return headers.cookie;
  if (Array.isArray(headers.cookie) && headers.cookie.length > 0) {
    return headers.cookie[0];
  }

  return null;
}

function extractSessionTokenFromWsCookieObject(ws: any): string | null {
  const cookieObject = ws?.data?.cookie;
  if (!cookieObject || typeof cookieObject !== "object") return null;

  const normalToken = cookieObject["better-auth.session_token"]?.value;
  if (typeof normalToken === "string" && normalToken.length > 0) {
    return normalToken;
  }

  const secureToken = cookieObject["__Secure-better-auth.session_token"]?.value;
  if (typeof secureToken === "string" && secureToken.length > 0) {
    return secureToken;
  }

  return null;
}

async function authenticateWebSocket(
  ws: any,
  explicitSessionToken?: string,
  explicitWorkspaceId?: string
): Promise<
  | { ok: true; wsUser: WsUser }
  | { ok: false; error: string; shouldClose?: boolean }
> {
  const sessionToken =
    (explicitSessionToken
      ? await resolveSessionToken(explicitSessionToken)
      : null) ??
    (await resolveSessionTokenFromCookieHeader(getCookieHeaderFromWs(ws))) ??
    (await resolveSessionToken(extractSessionTokenFromWsCookieObject(ws)));

  if (!sessionToken) {
    return { ok: false, error: "Missing session token" };
  }

  // Validate session token against Better Auth session table
  const [session] = await db
    .select()
    .from(baSession)
    .where(eq(baSession.token, sessionToken))
    .limit(1);

  if (!session || new Date(session.expiresAt) < new Date()) {
    return {
      ok: false,
      error: "Invalid or expired session",
      shouldClose: true,
    };
  }

  const userId = session.userId;
  const orgId = explicitWorkspaceId?.trim() || session.activeOrganizationId;

  if (!orgId) {
    return {
      ok: false,
      error: "No active workspace",
    };
  }

  // Verify user exists
  const [user] = await db
    .select()
    .from(baUser)
    .where(eq(baUser.id, userId))
    .limit(1);

  if (!user) {
    return {
      ok: false,
      error: "User not found",
      shouldClose: true,
    };
  }

  // Check membership
  const [membership] = await db
    .select()
    .from(baMember)
    .where(and(eq(baMember.userId, userId), eq(baMember.organizationId, orgId)))
    .limit(1);

  if (!membership) {
    return {
      ok: false,
      error: "Not a member of this workspace",
      shouldClose: true,
    };
  }

  const role = (membership.role ?? "member") as RoleName;

  // Register connection
  registerConnection(userId, orgId, ws);

  const wsUser = { userId, orgId, role, displayName: user.name };
  wsUserMap.set(ws, wsUser);

  // Broadcast user:joined
  broadcastToOrg(
    orgId,
    "user:joined",
    {
      user_id: userId,
      display_name: user.name,
    },
    userId
  );

  // Flush offline queue
  const pendingBlobs = await db
    .select()
    .from(offlineQueue)
    .where(eq(offlineQueue.recipientId, userId));

  if (pendingBlobs.length > 0) {
    ws.send(
      JSON.stringify({
        event: "offline:flush",
        data: {
          blobs: pendingBlobs.map((b) => b.blob),
        },
      })
    );

    // Delete flushed blobs
    for (const blob of pendingBlobs) {
      await db
        .delete(offlineQueue)
        .where(eq(offlineQueue.id, blob.id));
    }
  }

  ws.send(
    JSON.stringify({
      event: "registered",
      data: { user_id: userId, org_id: orgId },
    })
  );

  return { ok: true, wsUser };
}

export const wsHandler = new Elysia()
  .ws("/ws", {
    body: t.Object({
      event: t.String(),
      data: t.Any(),
    }),

    async open(ws) {
      // Try automatic cookie-based auth on handshake.
      const authResult = await authenticateWebSocket(ws);
      if (authResult.ok === false && authResult.error !== "Missing session token") {
        ws.send(
          JSON.stringify({
            event: "error",
            data: { message: authResult.error },
          })
        );
      }
    },

    async message(ws, message) {
      const { event, data } = message as { event: string; data: any };

      switch (event) {
        // ── register ──────────────────────────────────────
        case "register": {
          try {
            const alreadyRegistered = wsUserMap.get(ws);
            if (alreadyRegistered) {
              ws.send(
                JSON.stringify({
                  event: "registered",
                  data: {
                    user_id: alreadyRegistered.userId,
                    org_id: alreadyRegistered.orgId,
                  },
                })
              );
              break;
            }

            const sessionToken =
              typeof data?.session_token === "string"
                ? data.session_token
                : undefined;
            const workspaceId =
              typeof data?.workspace_id === "string"
                ? data.workspace_id
                : undefined;

            const authResult = await authenticateWebSocket(
              ws,
              sessionToken,
              workspaceId
            );
            if (authResult.ok === false) {
              ws.send(
                JSON.stringify({
                  event: "error",
                  data: { message: authResult.error },
                })
              );
              if (authResult.shouldClose) ws.close();
              return;
            }
          } catch (e) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "Registration failed" },
              })
            );
          }
          break;
        }

        // ── WebRTC signaling ──────────────────────────────
        case "webrtc:offer":
        case "webrtc:answer":
        case "webrtc:ice": {
          const wsUser = wsUserMap.get(ws);
          if (!wsUser) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "Not authenticated" },
              })
            );
            return;
          }

          const targetId = data.target_user_id as string;
          const targetWs = getConnection(targetId);

          if (targetWs) {
            const relayData: any = { ...data };
            relayData.from_user_id = wsUser.userId;
            delete relayData.target_user_id;

            targetWs.send(JSON.stringify({ event, data: relayData }));
          }
          break;
        }

        // ── offline:deliver ───────────────────────────────
        case "offline:deliver": {
          const wsUser = wsUserMap.get(ws);
          if (!wsUser) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "Not authenticated" },
              })
            );
            return;
          }

          // Guests cannot send messages
          if (ROLE_LEVELS[wsUser.role] < ROLE_LEVELS.member) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "Guests cannot send messages" },
              })
            );
            return;
          }

          const recipientId = data.recipient_id as string;
          const blob = data.blob as string;

          // If recipient is online, deliver directly
          if (isOnline(recipientId)) {
            const recipientWs = getConnection(recipientId);
            if (recipientWs) {
              recipientWs.send(
                JSON.stringify({
                  event: "offline:flush",
                  data: { blobs: [blob] },
                })
              );
            }
          } else {
            // Store in offline queue
            await db.insert(offlineQueue).values({
              orgId: wsUser.orgId,
              recipientId,
              blob,
            });
          }
          break;
        }

        // ── room:message ──────────────────────────────────
        case "room:message": {
          const wsUser = wsUserMap.get(ws);
          if (!wsUser) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "Not authenticated" },
              })
            );
            return;
          }

          if (ROLE_LEVELS[wsUser.role] < ROLE_LEVELS.member) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "Guests cannot send messages" },
              })
            );
            return;
          }

          const roomId = data.room_id as string;
          const content = data.content as string;
          const trimmedContent = (content ?? "").trim();

          if (!roomId || !trimmedContent) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "room_id and content are required" },
              })
            );
            return;
          }

          if (!UUID_PATTERN.test(roomId)) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "Invalid room_id format" },
              })
            );
            return;
          }

          try {
            // Verify the sender is a member of this room in the active org.
            const [membership] = await db
              .select({ roomId: roomMembers.roomId })
              .from(roomMembers)
              .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
              .where(
                and(
                  eq(roomMembers.roomId, roomId),
                  eq(roomMembers.userId, wsUser.userId),
                  eq(rooms.orgId, wsUser.orgId)
                )
              )
              .limit(1);

            if (!membership) {
              ws.send(
                JSON.stringify({
                  event: "error",
                  data: { message: "You are not a member of this room" },
                })
              );
              return;
            }

            // Persist the message in the database so it's not lost on refresh
            const [newMessage] = await db
              .insert(messages)
              .values({
                roomId,
                userId: wsUser.userId,
                content: trimmedContent,
              })
              .returning();

            if (newMessage) {
              // Broadcast to everyone in the same organization
              broadcastToOrg(wsUser.orgId, "room:message", {
                id: newMessage.id,
                room_id: roomId,
                user_id: wsUser.userId,
                author_name: wsUser.displayName,
                content: trimmedContent,
                timestamp: newMessage.createdAt.toISOString()
              });
            }
          } catch (err) {
            console.error("Failed to save message:", err);
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: "Failed to persist message" },
              })
            );
          }
          break;
        }

        // ── supernode:heartbeat ───────────────────────────
        case "supernode:heartbeat": {
          const wsUser = wsUserMap.get(ws);
          if (!wsUser) return;

          await db
            .update(supernodeRegistry)
            .set({ lastHeartbeat: new Date() })
            .where(
              and(
                eq(supernodeRegistry.userId, wsUser.userId),
                eq(supernodeRegistry.orgId, wsUser.orgId),
                eq(supernodeRegistry.isActive, true)
              )
            );
          break;
        }

        default:
          ws.send(
            JSON.stringify({
              event: "error",
              data: { message: `Unknown event: ${event}` },
            })
          );
      }
    },

    close(ws) {
      const wsUser = wsUserMap.get(ws);
      if (wsUser) {
        // Broadcast user:left
        broadcastToOrg(wsUser.orgId, "user:left", {
          user_id: wsUser.userId,
        }, wsUser.userId);

        removeConnection(wsUser.userId);
        wsUserMap.delete(ws);
      }
    },
  });
