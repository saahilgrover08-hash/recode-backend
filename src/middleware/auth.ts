import { Elysia } from "elysia";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.ts";
import { baUser, baSession, baMember } from "../db/schema.ts";
import {
  resolveSessionToken,
  resolveSessionTokenFromCookieHeader,
} from "../auth/session-token.ts";

/**
 * Better Auth session-based authentication middleware.
 * Reads token from Authorization header or Better Auth cookies and
 * resolves the current user + active workspace membership.
 */

/** Extract Better Auth session token from request */
async function extractSessionToken(request: Request): Promise<string | null> {
  // 1. Try Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim() || null;
  }

  // 2. Try cookie
  return resolveSessionTokenFromCookieHeader(request.headers.get("cookie"));
}

/** Role hierarchy levels (maps Better Auth member roles to numeric levels) */
export const ROLE_LEVELS = {
  guest: 1,
  member: 2,
  manager: 3,
  admin: 4,
  owner: 5,
} as const;

export type RoleName = keyof typeof ROLE_LEVELS;

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  orgId: string;
  role: RoleName;
  roleLevel: number;
  displayName: string;
};

function logAuthDebug(
  request: Request,
  step: string,
  details: Record<string, unknown> = {}
) {
  const cookieHeader = request.headers.get("cookie");
  const cookieNames = cookieHeader
    ? cookieHeader
        .split(";")
        .map((part) => part.trim().split("=")[0])
        .filter(Boolean)
    : [];

  console.log("[auth]", {
    step,
    path: new URL(request.url).pathname,
    hasAuthorization: !!request.headers.get("authorization"),
    cookieNames,
    ...details,
  });
}

function getCtxUser(ctx: unknown): AuthUser | null {
  const user = (ctx as any)?.user;
  if (!user || typeof user !== "object") return null;
  if (typeof user.id !== "string" || typeof user.orgId !== "string") {
    return null;
  }
  return user as AuthUser;
}

function resolveRequestedWorkspaceId(request: Request): string | null {
  const workspaceId = request.headers.get("x-workspace-id")?.trim();
  return workspaceId || null;
}

async function resolveAuthenticatedUser(request: Request): Promise<AuthUser> {
  const token = await extractSessionToken(request);
  if (!token) {
    logAuthDebug(request, "missing-token");
    throw new Response("Unauthorized - no session token", { status: 401 });
  }

  const tokenPreview = `${token.slice(0, 8)}...${token.slice(-6)}`;

  const [session] = await db
    .select()
    .from(baSession)
    .where(eq(baSession.token, token))
    .limit(1);

  if (!session) {
    logAuthDebug(request, "session-not-found", { tokenPreview });
    throw new Response("Invalid or expired session", { status: 401 });
  }

  if (new Date(session.expiresAt) < new Date()) {
    logAuthDebug(request, "session-expired", {
      tokenPreview,
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
    });
    throw new Response("Session expired", { status: 401 });
  }

  const [user] = await db
    .select()
    .from(baUser)
    .where(eq(baUser.id, session.userId))
    .limit(1);

  if (!user) {
    logAuthDebug(request, "user-not-found", {
      tokenPreview,
      sessionId: session.id,
      userId: session.userId,
    });
    throw new Response("User not found", { status: 401 });
  }

  const requestedOrgId = resolveRequestedWorkspaceId(request);
  const orgId = requestedOrgId || session.activeOrganizationId;
  if (!orgId) {
    logAuthDebug(request, "missing-active-org", {
      tokenPreview,
      sessionId: session.id,
      userId: user.id,
      requestedOrgId,
    });
    throw new Response("No active workspace - select one first", {
      status: 400,
    });
  }

  const [membership] = await db
    .select()
    .from(baMember)
    .where(
      and(eq(baMember.userId, user.id), eq(baMember.organizationId, orgId))
    )
    .limit(1);

  if (!membership) {
    logAuthDebug(request, "membership-not-found", {
      tokenPreview,
      sessionId: session.id,
      userId: user.id,
      requestedOrgId,
      sessionOrgId: session.activeOrganizationId,
      orgId,
    });
    throw new Response("Not a member of this workspace", { status: 403 });
  }

  const role = (membership.role ?? "member") as RoleName;
  const roleLevel = ROLE_LEVELS[role] ?? ROLE_LEVELS.member;

  logAuthDebug(request, "authenticated", {
    tokenPreview,
    sessionId: session.id,
    userId: user.id,
    requestedOrgId,
    sessionOrgId: session.activeOrganizationId,
    orgId,
    role,
  });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    orgId,
    role,
    roleLevel,
    displayName: user.name,
  };
}

export async function resolveAuthContext({ request }: { request: Request }) {
  const user = await resolveAuthenticatedUser(request);
  return { user };
}

/**
 * Auth gate middleware.
 * Injects `ctx.user` for downstream handlers and blocks unauthenticated requests.
 */
export const requireAuth = new Elysia({ name: "requireAuth" }).resolve(
  { as: "global" },
  resolveAuthContext
);

/** Guard: caller's role >= minLevel */
export function requireRole(minLevel: number) {
  return new Elysia({ name: `role-${minLevel}` })
    .use(requireAuth)
    .onBeforeHandle((ctx: any) => {
      const user = getCtxUser(ctx);
      if (!user || user.roleLevel < minLevel) {
        throw new Response("Insufficient permissions", { status: 403 });
      }
    });
}

/** Check: actor's role level > target user's role level */
export async function assertRoleAboveTarget(
  actorRoleLevel: number,
  targetUserId: string,
  orgId: string
): Promise<void> {
  const [targetMembership] = await db
    .select({ role: baMember.role })
    .from(baMember)
    .where(
      and(eq(baMember.userId, targetUserId), eq(baMember.organizationId, orgId))
    )
    .limit(1);

  if (!targetMembership) {
    throw new Response("Target user not found", { status: 404 });
  }

  const targetLevel =
    ROLE_LEVELS[(targetMembership.role ?? "member") as RoleName] ??
    ROLE_LEVELS.member;

  if (actorRoleLevel <= targetLevel) {
    throw new Response("Cannot act on a user of equal or higher role", {
      status: 403,
    });
  }
}
