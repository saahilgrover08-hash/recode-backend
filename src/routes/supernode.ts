import { Elysia, t } from "elysia";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.ts";
import { supernodeRegistry } from "../db/schema.ts";
import { resolveAuthContext, ROLE_LEVELS } from "../middleware/auth.ts";
import { broadcastToOrg } from "../ws/connections.ts";

/** Elect the best SuperNode for an org based on priority rules */
async function electSuperNode(orgId: string): Promise<void> {
  // Clear any previously elected node for org
  await db
    .update(supernodeRegistry)
    .set({ elected: false })
    .where(
      and(
        eq(supernodeRegistry.orgId, orgId),
        eq(supernodeRegistry.elected, true)
      )
    );

  // Find best candidate: active, recent heartbeat, priority by:
  // 1. longest online (earliest heartbeat that's still alive)
  // 2. plugged into power
  // 3. most storage available
  const candidates = await db
    .select()
    .from(supernodeRegistry)
    .where(
      and(
        eq(supernodeRegistry.orgId, orgId),
        eq(supernodeRegistry.isActive, true)
      )
    )
    .orderBy(
      desc(supernodeRegistry.onPower),
      desc(supernodeRegistry.storageMb),
      supernodeRegistry.lastHeartbeat // asc — longest online first
    )
    .limit(1);

  if (candidates.length > 0) {
    const winner = candidates[0]!;
    await db
      .update(supernodeRegistry)
      .set({ elected: true })
      .where(eq(supernodeRegistry.id, winner.id));

    // Broadcast new SuperNode to all org devices
    broadcastToOrg(orgId, "supernode:elected", {
      user_id: winner.userId,
      device_label: winner.deviceLabel,
    });
  }
}

export { electSuperNode };

export const supernodeRoutes = new Elysia({ prefix: "/api/v1/supernode" })
  .resolve(resolveAuthContext)

  // ── POST /supernode/register ───────────────────────────
  .post(
    "/register",
    async ({ user, body }) => {
      // Guests cannot become SuperNodes
      if (user.roleLevel < ROLE_LEVELS.member) {
        throw new Response("Members and above only", { status: 403 });
      }

      const [node] = await db
        .insert(supernodeRegistry)
        .values({
          orgId: user.orgId,
          userId: user.id,
          deviceLabel: body.deviceLabel,
          onPower: body.onPower ?? false,
          storageMb: body.storageMb ?? 0,
          isActive: true,
          elected: false,
        })
        .returning();

      if (!node) {
        throw new Response("Failed to register supernode", { status: 500 });
      }

      // If no current elected SuperNode, elect this one
      const [currentElected] = await db
        .select()
        .from(supernodeRegistry)
        .where(
          and(
            eq(supernodeRegistry.orgId, user.orgId),
            eq(supernodeRegistry.elected, true),
            eq(supernodeRegistry.isActive, true)
          )
        )
        .limit(1);

      if (!currentElected) {
        await electSuperNode(user.orgId);
      }

      return { id: node.id, deviceLabel: node.deviceLabel };
    },
    {
      body: t.Object({
        deviceLabel: t.String({ minLength: 1 }),
        onPower: t.Optional(t.Boolean()),
        storageMb: t.Optional(t.Number()),
      }),
    }
  )

  // ── POST /supernode/heartbeat ──────────────────────────
  .post("/heartbeat", async ({ user }) => {
    await db
      .update(supernodeRegistry)
      .set({ lastHeartbeat: new Date() })
      .where(
        and(
          eq(supernodeRegistry.userId, user.id),
          eq(supernodeRegistry.orgId, user.orgId),
          eq(supernodeRegistry.isActive, true)
        )
      );

    return { ok: true };
  })

  // ── GET /supernode/current ─────────────────────────────
  .get("/current", async ({ user }) => {
    const [current] = await db
      .select({
        id: supernodeRegistry.id,
        userId: supernodeRegistry.userId,
        deviceLabel: supernodeRegistry.deviceLabel,
        onPower: supernodeRegistry.onPower,
        storageMb: supernodeRegistry.storageMb,
        lastHeartbeat: supernodeRegistry.lastHeartbeat,
      })
      .from(supernodeRegistry)
      .where(
        and(
          eq(supernodeRegistry.orgId, user.orgId),
          eq(supernodeRegistry.elected, true),
          eq(supernodeRegistry.isActive, true)
        )
      )
      .limit(1);

    return current ?? null;
  })

  // ── POST /supernode/resign ─────────────────────────────
  .post("/resign", async ({ user }) => {
    await db
      .update(supernodeRegistry)
      .set({ isActive: false, elected: false })
      .where(
        and(
          eq(supernodeRegistry.userId, user.id),
          eq(supernodeRegistry.orgId, user.orgId)
        )
      );

    // Trigger re-election
    await electSuperNode(user.orgId);

    return { ok: true };
  });
