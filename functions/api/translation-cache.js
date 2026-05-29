const CACHE_BINDING = "LYRIC_TRANSLATION_CACHE";
const MAX_KEY_LENGTH = 180;
const MAX_LINES = 250;
const MAX_LINE_LENGTH = 1200;
const MAX_BODY_BYTES = 256 * 1024;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...(init.headers || {}),
    },
  });
}

function noStoreJson(data, init = {}) {
  return json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function cacheStore(env) {
  return env && env[CACHE_BINDING];
}

function normalizeKey(key) {
  const value = String(key || "").trim();
  if (!value || value.length > MAX_KEY_LENGTH) return "";
  if (!value.startsWith("lrclib:")) return "";
  if (!value.endsWith("|browser-translator-en-v1")) return "";
  return value;
}

function normalizePayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = normalizeKey(raw.key);
  const linesHash = String(raw.linesHash || "");
  const english = Array.isArray(raw.english) ? raw.english : [];
  if (!key || !linesHash || english.length < 1 || english.length > MAX_LINES) return null;
  if (!english.some((line) => String(line || "").trim())) return null;
  return {
    key,
    value: {
      linesHash,
      english: english.map((line) => String(line || "").slice(0, MAX_LINE_LENGTH)),
      savedAt: Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : Date.now(),
    },
  };
}

export async function onRequestGet({ env, request }) {
  const store = cacheStore(env);
  if (!store) return noStoreJson({ error: "Translation cache is not configured." }, { status: 503 });

  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get("key"));
  if (!key) return noStoreJson({ error: "Invalid cache key." }, { status: 400 });

  const entry = await store.get(key, "json");
  if (!entry) return noStoreJson({ error: "Cache miss." }, { status: 404 });
  return json(entry);
}

export async function onRequestPut({ env, request }) {
  const store = cacheStore(env);
  if (!store) return noStoreJson({ error: "Translation cache is not configured." }, { status: 503 });

  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) {
    return noStoreJson({ error: "Payload too large." }, { status: 413 });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return noStoreJson({ error: "Invalid JSON." }, { status: 400 });
  }

  const payload = normalizePayload(body);
  if (!payload) return noStoreJson({ error: "Invalid translation cache payload." }, { status: 400 });

  await store.put(payload.key, JSON.stringify(payload.value));
  return noStoreJson({ ok: true });
}

export function onRequestOptions() {
  return new Response(null, { status: 204 });
}
