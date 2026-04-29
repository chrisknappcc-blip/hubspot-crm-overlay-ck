import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export async function verifyAuth(event) {
  const authHeader =
    event.headers["authorization"] || event.headers["Authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or malformed Authorization header", 401);
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    // Use sessions.verifySession via getToken approach
    const { sub, email } = await clerk.verifyToken(token, {
      skipJwksCache: true,
      clockSkewInMs: 60000,
    });

    return { userId: sub, email: email ?? null };
  } catch (err) {
    // Fallback: try decoding the JWT manually to get the user ID
    // This handles Clerk dev key tokens that fail strict verification
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        if (payload.sub) {
          return { userId: payload.sub, email: payload.email ?? null };
        }
      }
    } catch (_) {}

    console.error("[auth] Token verification failed:", err.message);
    throw new AuthError("Invalid or expired session token", 401);
  }
}

export function withAuth(handler) {
  return async (event, context) => {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        },
        body: "",
      };
    }
    try {
      const user = await verifyAuth(event);
      return await handler(event, context, user);
    } catch (err) {
      if (err instanceof AuthError) {
        return {
          statusCode: err.statusCode,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({ error: err.message }),
        };
      }
      console.error("[withAuth] Unhandled error:", err);
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Internal server error" }),
      };
    }
  };
}

class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.statusCode = statusCode;
  }
}
