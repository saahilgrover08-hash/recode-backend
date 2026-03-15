/**
 * In-memory WebSocket connection tracker.
 * Maps userId → WebSocket for direct messaging,
 * and orgId → Set<userId> for org-wide broadcasts.
 */

// userId → ws (raw WebSocket handle from Elysia .ws())
const userConnections = new Map<string, any>();
// orgId → Set<userId>
const orgUsers = new Map<string, Set<string>>();
// userId → orgId (reverse lookup)
const userOrg = new Map<string, string>();

export function registerConnection(
  userId: string,
  orgId: string,
  ws: any
): void {
  userConnections.set(userId, ws);
  userOrg.set(userId, orgId);

  if (!orgUsers.has(orgId)) {
    orgUsers.set(orgId, new Set());
  }
  orgUsers.get(orgId)!.add(userId);
}

export function removeConnection(userId: string): void {
  const orgId = userOrg.get(userId);
  userConnections.delete(userId);
  userOrg.delete(userId);

  if (orgId) {
    orgUsers.get(orgId)?.delete(userId);
    if (orgUsers.get(orgId)?.size === 0) {
      orgUsers.delete(orgId);
    }
  }
}

export function getConnection(userId: string): any | undefined {
  return userConnections.get(userId);
}

export function isOnline(userId: string): boolean {
  return userConnections.has(userId);
}

export function getOrgOnlineUsers(orgId: string): Set<string> {
  return orgUsers.get(orgId) ?? new Set();
}

/** Send a JSON message to a specific user if online */
export function sendToUser(userId: string, event: string, data: any): boolean {
  const ws = userConnections.get(userId);
  if (ws) {
    ws.send(JSON.stringify({ event, data }));
    return true;
  }
  return false;
}

/** Broadcast a JSON message to all online users in an org */
export function broadcastToOrg(
  orgId: string,
  event: string,
  data: any,
  excludeUserId?: string
): void {
  const users = orgUsers.get(orgId);
  if (!users) return;

  const message = JSON.stringify({ event, data });
  for (const uid of users) {
    if (uid === excludeUserId) continue;
    const ws = userConnections.get(uid);
    if (ws) {
      ws.send(message);
    }
  }
}

/** Close all WS connections for an org (used by panic wipe) */
export function disconnectOrg(orgId: string): void {
  const users = orgUsers.get(orgId);
  if (!users) return;

  for (const uid of [...users]) {
    const ws = userConnections.get(uid);
    if (ws) {
      try {
        ws.send(JSON.stringify({ event: "panic:wipe", data: { org_id: orgId } }));
        ws.close();
      } catch {
        // connection might already be closed
      }
    }
    removeConnection(uid);
  }
}

/** Close WS for a specific user (kick / guest deactivation) */
export function disconnectUser(userId: string, event?: string, data?: any): void {
  const ws = userConnections.get(userId);
  if (ws) {
    try {
      if (event) {
        ws.send(JSON.stringify({ event, data }));
      }
      ws.close();
    } catch {
      // ignore
    }
  }
  removeConnection(userId);
}
