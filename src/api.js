// src/api.js
export async function apiFetch(path, getToken, options = {}) {
  const token = await getToken({ template: null })
  
  if (!token) {
    throw new Error('No session token available. Please sign in again.')
  }

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
