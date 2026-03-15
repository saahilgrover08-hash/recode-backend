import { Elysia } from "elysia";
import { node } from "@elysiajs/node";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { config } from "./config.ts";
import { orgRoutes } from "./routes/org.ts";
import { roomRoutes } from "./routes/room.ts";
import { archiveRoutes } from "./routes/archive.ts";
import { queueRoutes } from "./routes/queue.ts";
import { supernodeRoutes } from "./routes/supernode.ts";
import { panicRoutes } from "./routes/panic.ts";
import { startCleanupJobs } from "./jobs/cleanup.ts";

const isBunRuntime = typeof Bun !== "undefined";

const app = new Elysia(isBunRuntime ? {} : { adapter: node() })
  // ── Global plugins ───────────────────────────────────
  .use(
    cors({
      origin: true, // Allow all origins (restrict in production)
      credentials: true, // Important: allow cookies to be sent
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  )
  .use(
    swagger({
      documentation: {
        info: {
          title: "Nexus Backend API",
          version: "2.0.0",
          description:
            "P2P hybrid messaging backend — Better Auth session validation, signaling, offline queue, encrypted archive, SuperNode election",
        },
      },
    })
  )

  // ── Health check ─────────────────────────────────────
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }))

  // ── Root redirect ────────────────────────────────────
  .get("/", ({ set }) => {
    set.redirect = "/swagger";
  })

  // ── REST routes ──────────────────────────────────────
  .use(orgRoutes)
  .use(roomRoutes)
  .use(archiveRoutes)
  .use(queueRoutes)
  .use(supernodeRoutes)
  .use(panicRoutes)

  // ── WebSocket ────────────────────────────────────────

  // ── Error handling ───────────────────────────────────
  .onError(async ({ code, error, set }) => {
    if (error instanceof Response) {
      set.status = error.status as any;
      const body = await error.text().catch(() => "");
      return { error: body || error.statusText || `HTTP ${error.status}` };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Not found" };
    }

    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "Validation failed", details: error.message };
    }

    console.error(`[${code}]`, error);
    set.status = 500;
    return { error: "Internal server error" };
  })

  // ── Start ────────────────────────────────────────────
;

if (isBunRuntime) {
  const { wsHandler } = await import("./ws/handler.ts");
  app.use(wsHandler);
} else {
  console.warn(
    "WebSocket handler is disabled under Node runtime; REST APIs remain available."
  );
}

app.listen({
  hostname: config.HOST,
  port: config.PORT,
});

// Start background jobs
startCleanupJobs();

console.log(
  `🔒 Nexus backend running at http://${config.HOST}:${config.PORT}`
);
console.log(`📖 Swagger docs: http://${config.HOST}:${config.PORT}/swagger`);

export type App = typeof app;
