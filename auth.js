// netlify/functions/utils//auth.js
// Verifies Clerk JWT on every incoming request.
// Returns { userId, email } on success, or throws with a 401-friendly message.
//
// Setup:
//   1. Install: npm install @clerk/backend
//   2. Set env var CLERK_SECRET_KEY in Netlify (from your Clerk dashboard)
//   3. Call verifyAuth(event) at the top of every function handler

import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export async function verifyAuth(event) {
  const authHeader = event.headers["authorization"] || event.headers["Authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or malformed Authorization header", 401);
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    // Verify the Clerk session token
    const payload = await clerk.verifyToken(token);

    return {
      userId: payload.sub,           // Clerk user ID — used as blob storage key
      email: payload.email ?? null,
    };
  } catch (err) {
    console.error("[auth] Token verification failed:", err.message);
    throw new AuthError("Invalid or expired session token", 401);
  }
}

// Helper: wrap a Netlify handler with auth + consistent error responses
export function withAuth(handler) {
  return async (event, context) => {
    try {
      const user = await verifyAuth(event);
      return await handler(event, context, user);
    } catch (err) {
      if (err instanceof AuthError) {
        return {
          statusCode: err.statusCode,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: err.message }),
        };
      }
      console.error("[withAuth] Unhandled error:", err);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
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
