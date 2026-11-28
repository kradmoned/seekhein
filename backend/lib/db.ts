import { Pool } from "pg"

const globalForDb = globalThis as typeof globalThis & {
  dbPool?: Pool
}

function createPool() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing from .env.local")
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })

  // Handle errors from connections sitting idle in the pool.
  pool.on("error", (error) => {
    console.error("Unexpected database connection error:", error.message)
  })

  return pool
}

// Reuse the pool when Next.js reloads files during development.
export const pool = globalForDb.dbPool ?? createPool()

globalForDb.dbPool = pool