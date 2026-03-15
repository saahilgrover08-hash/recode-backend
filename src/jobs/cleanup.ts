import { lt, and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { offlineQueue, supernodeRegistry } from "../db/schema.ts";
import { config } from "../config.ts";
import { disconnectUser } from "../ws/connections.ts";
import { electSuperNode } from "../routes/supernode.ts";

/** Delete offline_queue blobs older than 48 hours */
async function cleanupOfflineQueue(): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await db.delete(offlineQueue).where(lt(offlineQueue.createdAt, cutoff));
}

/** Check SuperNode heartbeats and re-elect if timeout exceeded */
async function checkSupernodeHeartbeats(): Promise<void> {
  const timeout = config.SUPERNODE_TIMEOUT * 1000; // to ms
  const cutoff = new Date(Date.now() - timeout);

  // Find timed-out elected SuperNodes
  const timedOut = await db
    .select()
    .from(supernodeRegistry)
    .where(
      and(
        eq(supernodeRegistry.elected, true),
        eq(supernodeRegistry.isActive, true),
        lt(supernodeRegistry.lastHeartbeat, cutoff)
      )
    );

  for (const node of timedOut) {
    // Mark as inactive
    await db
      .update(supernodeRegistry)
      .set({ isActive: false, elected: false })
      .where(eq(supernodeRegistry.id, node.id));

    // Re-elect for this org
    await electSuperNode(node.orgId);
  }
}

async function runJob(name: string, job: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (error) {
    console.error(`[jobs] ${name} failed`, error);
  }
}

/** Start all background cleanup jobs */
export function startCleanupJobs(): void {
  // Offline queue cleanup — every 15 minutes
  setInterval(() => {
    void runJob("cleanup-offline-queue", cleanupOfflineQueue);
  }, 15 * 60 * 1000);

  // SuperNode heartbeat check — every 15 seconds (timeout is 60s)
  setInterval(() => {
    void runJob("check-supernode-heartbeats", checkSupernodeHeartbeats);
  }, 15 * 1000);

  console.log("[jobs] Background cleanup jobs started");
}
