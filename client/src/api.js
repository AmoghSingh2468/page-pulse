const BASE = import.meta.env.VITE_API_BASE_URL || '';

/**
 * Call the Page Pulse audit API.
 * @param {string} url
 * @returns {Promise<object>} the audit result (data payload)
 */
export async function auditUrl(url) {
  let res;
  try {
    res = await fetch(`${BASE}/v1/audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch {
    throw new Error('Could not reach the audit service. Is the API running?');
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('The audit service returned an unexpected response.');
  }

  if (!res.ok) {
    const message = body?.error?.message || `Request failed (${res.status}).`;
    const err = new Error(message);
    err.code = body?.error?.code;
    throw err;
  }
  return body.data;
}
