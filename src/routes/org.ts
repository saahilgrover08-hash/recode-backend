import { Elysia, t } from "elysia";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.ts";
import { baUser, baMember, baOrganization } from "../db/schema.ts";
import {
  resolveAuthContext,
  ROLE_LEVELS,
  type RoleName,
  assertRoleAboveTarget,
} from "../middleware/auth.ts";
import { isOnline, broadcastToOrg, disconnectUser } from "../ws/connections.ts";

/**
 * Organisation routes — adapted for Better Auth.
 *
 * - Create/Join/Login are handled by Better Auth on the frontend.
 * - These routes handle workspace-specific operations that
 *   require the Elysia backend (member listing, kick, promote).
 */
export const orgRoutes = new Elysia({ prefix: "/api/v1/org" })
  .resolve(resolveAuthContext)

  // ── GET /org/info ──────────────────────────────────────
  // Returns the active workspace's info
  .get("/info", async ({ user }) => {
    const [org] = await db
      .select()
      .from(baOrganization)
      .where(eq(baOrganization.id, user.orgId))
      .limit(1);

    if (!org) {
      throw new Response("Organisation not found", { status: 404 });
    }

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
    };
  })

  // ── GET /org/members ───────────────────────────────────
  .get("/members", async ({ user }) => {
    const members = await db
      .select({
        memberId: baMember.id,
        userId: baMember.userId,
        role: baMember.role,
        joinedAt: baMember.createdAt,
      })
      .from(baMember)
      .where(eq(baMember.organizationId, user.orgId));

    // Enrich with user details
    const enriched = await Promise.all(
      members.map(async (m) => {
        const [u] = await db
          .select({ name: baUser.name, email: baUser.email, image: baUser.image })
          .from(baUser)
          .where(eq(baUser.id, m.userId))
          .limit(1);

        return {
          id: m.userId,
          displayName: u?.name ?? "Unknown",
          email: u?.email,
          image: u?.image,
          role: m.role,
          joinedAt: m.joinedAt,
          online: isOnline(m.userId),
        };
      })
    );

    return enriched;
  })

  // ── POST /org/kick (admin+) ────────────────────────────
  .post(
    "/kick",
    async (ctx: any) => {
      const { user, body } = ctx;
      if (user.roleLevel < ROLE_LEVELS.admin) {
        throw new Response("Admin required", { status: 403 });
      }

      await assertRoleAboveTarget(user.roleLevel, body.targetUserId, user.orgId);

      // Remove from Better Auth member table
      await db
        .delete(baMember)
        .where(
          and(
            eq(baMember.userId, body.targetUserId),
            eq(baMember.organizationId, user.orgId)
          )
        );

      // Disconnect and broadcast
      disconnectUser(body.targetUserId, "user:kicked", {
        user_id: body.targetUserId,
      });
      broadcastToOrg(user.orgId, "user:kicked", {
        user_id: body.targetUserId,
      });

      return { success: true, kicked: body.targetUserId };
    },
    {
      body: t.Object({
        targetUserId: t.String({ minLength: 1 }),
      }),
    }
  )

  // ── POST /org/promote (admin+) ─────────────────────────
  .post(
    "/promote",
    async (ctx: any) => {
      const { user, body } = ctx;
      if (user.roleLevel < ROLE_LEVELS.admin) {
        throw new Response("Admin required", { status: 403 });
      }

      await assertRoleAboveTarget(user.roleLevel, body.targetUserId, user.orgId);

      const newRole = body.newRole as RoleName;

      // Cannot promote to own level or above
      if (ROLE_LEVELS[newRole] >= user.roleLevel) {
        throw new Response("Cannot promote to equal or higher role", {
          status: 403,
        });
      }

      // Cannot change to owner role
      if (newRole === "owner") {
        throw new Response("Cannot promote to owner", { status: 403 });
      }

      // Update role in Better Auth member table
      await db
        .update(baMember)
        .set({ role: newRole })
        .where(
          and(
            eq(baMember.userId, body.targetUserId),
            eq(baMember.organizationId, user.orgId)
          )
        );

      return { success: true, targetUserId: body.targetUserId, newRole };
    },
    {
      body: t.Object({
        targetUserId: t.String({ minLength: 1 }),
        newRole: t.Union([
          t.Literal("admin"),
          t.Literal("manager"),
          t.Literal("member"),
          t.Literal("guest"),
        ]),
      }),
    }
  );
