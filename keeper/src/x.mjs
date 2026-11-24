// X API v2 client, OAuth 1.0a user context.
//
// Why OAuth 1.0a: its four credentials (API key and secret, access token and secret) never expire,
// so the bot runs untouched for months. An OAuth 2.0 user token expires every 2 hours and its refresh
// token rotates on each use, so one failed refresh would silently stop the bot.

const TWEETS_URL = "https://api.x.com/2/tweets";
const MEDIA_URL = "https://api.x.com/2/media/upload";

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function hmacSha1(key, data) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** OAuth 1.0a Authorization header. JSON and multipart bodies are not part of the signature. */
export async function oauthHeader(env, method, url, extraParams = {}, fixed = {}) {
  for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) {
    if (!env[k]) throw new Error(`${k} secret is not set`);
  }
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: fixed.nonce ?? crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: fixed.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const all = { ...oauth, ...extraParams };
  for (const [k, v] of u.searchParams) all[k] = v;
  const paramStr = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join("&");
  const base = `${method.toUpperCase()}&${enc(u.origin + u.pathname)}&${enc(paramStr)}`;
  const signature = await hmacSha1(`${enc(env.X_API_SECRET)}&${enc(env.X_ACCESS_SECRET)}`, base);
  const h = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.keys(h).sort().map((k) => `${enc(k)}="${enc(h[k])}"`).join(", ");
}

/** Uploads a PNG, returns its media id. */
export async function uploadImage(env, png) {
  const url = env.X_MEDIA_UPLOAD_URL || MEDIA_URL;
  const form = new FormData();
  form.append("media", new Blob([png], { type: "image/png" }), "card.png");
  form.append("media_category", "tweet_image");
  const r = await fetch(url, { method: "POST", headers: { Authorization: await oauthHeader(env, "POST", url) }, body: form, signal: AbortSignal.timeout(Number(env.X_TIMEOUT_MS ?? 20000)) });
  const body = await r.text();
  if (!r.ok) throw new Error(`media upload ${r.status}: ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  const id = j.data?.id ?? j.media_id_string;
  if (!id) throw new Error(`media upload: no id in ${body.slice(0, 200)}`);
  return id;
}

/**
 * Posts a tweet, returns its id. An error carries `.status` when X answered with an HTTP status, and
 * `.ambiguous = true` when the tweet may have been created anyway (network error, timeout, 5xx,
 * unreadable 2xx), so the caller must not retry it blindly (round-5 finding 18).
 */
export async function postTweet(env, text, mediaId) {
  const payload = { text };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  let r, body;
  try {
    r = await fetch(TWEETS_URL, {
      method: "POST",
      headers: { Authorization: await oauthHeader(env, "POST", TWEETS_URL), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(env.X_TIMEOUT_MS ?? 20000)),
    });
    body = await r.text();
  } catch (e) {
    if (/secret is not set/.test(e.message ?? "")) throw e; // nothing was sent
    const err = new Error(`post: no answer from X (${e.name}: ${e.message})`);
    err.ambiguous = true;
    throw err;
  }
  if (!r.ok) {
    const err = new Error(`post ${r.status}: ${body.slice(0, 300)}`);
    err.status = r.status;
    err.ambiguous = r.status >= 500;
    throw err;
  }
  let id = null;
  try { id = JSON.parse(body).data?.id ?? null; } catch {}
  if (!id) {
    const err = new Error(`post ${r.status}: no tweet id in ${body.slice(0, 200)}`);
    err.ambiguous = true; // X accepted the request; the tweet very likely exists
    throw err;
  }
  return id;
}
