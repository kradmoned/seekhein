import { createRemoteJWKSet, errors, jwtVerify } from "jose"
import { pool } from "./db"

export type UserRole = "student" | "teacher"

export type Profile = {
  id: string
  email: string
  full_name: string | null
  role: UserRole
}

type AuthResult =
  | { user: Profile; error?: never }
  | { user?: never; error: Response }

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "")

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is missing from .env.local")
}

const issuer = `${supabaseUrl}/auth/v1`

// jose fetches and caches the public keys used to verify tokens.
const jwks = createRemoteJWKSet(
  new URL(`${issuer}/.well-known/jwks.json`),
)

export async function requireUser(
  req: Request,
  requiredRole?: UserRole,
): Promise<AuthResult> {
  const authorization = req.headers.get("authorization")
  const match = authorization?.match(/^Bearer\s+(\S+)$/i)

  if (!match) {
    return {
      error: Response.json(
        { error: "A Bearer access token is required" },
        { status: 401 },
      ),
    }
  }

  try {
    const { payload } = await jwtVerify(match[1], jwks, {
      issuer,
      audience: "authenticated",
      algorithms: ["ES256", "RS256"],
      requiredClaims: ["sub", "exp"],
    })

    // Supabase user IDs are UUIDs. Validate before querying Postgres.
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    if (!payload.sub || !uuidPattern.test(payload.sub)) {
      return {
        error: Response.json(
          { error: "Invalid user ID in access token" },
          { status: 401 },
        ),
      }
    }

    const result = await pool.query<Profile>(
      `SELECT id, email, full_name, role
       FROM public.profiles
       WHERE id = $1`,
      [payload.sub],
    )

    const user = result.rows[0]

    if (!user) {
      return {
        error: Response.json(
          { error: "User profile not found" },
          { status: 403 },
        ),
      }
    }

    // Authorization uses the role stored in the database.
    if (requiredRole && user.role !== requiredRole) {
      return {
        error: Response.json(
          { error: "You do not have permission to access this resource" },
          { status: 403 },
        ),
      }
    }

    return { user }
  } catch (error) {
    if (
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JOSEAlgNotAllowed ||
      error instanceof errors.JWKSNoMatchingKey
    ) {
      return {
        error: Response.json(
          { error: "Invalid or expired access token" },
          { status: 401 },
        ),
      }
    }

    // Keep internal database and network errors out of API responses.
    console.error(
      "Authentication failed:",
      error instanceof Error ? error.message : "Unknown error",
    )

    return {
      error: Response.json(
        { error: "Unable to authenticate request" },
        { status: 500 },
      ),
    }
  }
}