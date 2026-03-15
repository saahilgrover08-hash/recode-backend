function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  DATABASE_URL: requireEnv("DATABASE_URL"),
  HOST: process.env.HOST ?? "0.0.0.0",
  PORT: Number(process.env.PORT ?? 3000),
  SUPERNODE_TIMEOUT: Number(process.env.SUPERNODE_TIMEOUT ?? 60), // seconds
  MAX_BLOB_SIZE_MB: Number(process.env.MAX_BLOB_SIZE_MB ?? 10),
  BLOB_STORAGE: (process.env.BLOB_STORAGE ?? "local") as "local" | "s3",
  LOCAL_BLOB_DIR: process.env.LOCAL_BLOB_DIR ?? "./blobs",
} as const;
