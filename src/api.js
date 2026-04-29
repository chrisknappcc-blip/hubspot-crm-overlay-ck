// src/api.js
// Wraps all backend calls with the Clerk session token.
// Usage: import { apiFetch } from './api'
//        const data = await apiFetch('/api/hubspot/signals?hours=48', getToken)

export async function apiFetch(path, getToken, options = {}) {
  const token = await getToken()
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  return res.json()
}
