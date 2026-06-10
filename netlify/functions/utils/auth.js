// netlify/functions/utils/auth.js
// Netlify Identity JWT verification — replaces @clerk/backend

export async function verifyAuth(event, context) {
  // Netlify automatically verifies the Netlify Identity JWT and populates
  // context.clientContext.user when a valid Bearer token is present
  const ctxUser = context?.clientContext?.user
  if (ctxUser?.sub) {
    return { userId: ctxUser.sub, email: ctxUser.email ?? null }
  }

  // Fallback: manually decode the JWT (handles local dev and edge cases)
  const authHeader = event.headers['authorization'] || event.headers['Authorization']
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header', 401)
  }

  const token = authHeader.replace('Bearer ', '').trim()
  try {
    const parts = token.split('.')
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1]))
      if (payload.sub) {
        return { userId: payload.sub, email: payload.email ?? null }
      }
    }
  } catch (_) {}

  throw new AuthError('Invalid or expired session token', 401)
}

export function withAuth(handler) {
  return async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        },
        body: '',
      }
    }
    try {
      const user = await verifyAuth(event, context)
      return await handler(event, context, user)
    } catch (err) {
      if (err instanceof AuthError) {
        return {
          statusCode: err.statusCode,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({ error: err.message }),
        }
      }
      console.error('[withAuth] Unhandled error:', err)
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Internal server error' }),
      }
    }
  }
}

class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message)
    this.statusCode = statusCode
  }
}
