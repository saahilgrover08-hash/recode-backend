function parseCookieHeader(cookieHeader: string): Record<string, string> {
  return Object.fromEntries(
    cookieHeader.split(";").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")];
    })
  );
}

function normalizeCookieValue(value: string | null): string | null {
  if (!value) return null;

  let normalized = value.trim();

  if (
    normalized.length >= 2 &&
    normalized.startsWith('"') &&
    normalized.endsWith('"')
  ) {
    normalized = normalized.slice(1, -1);
  }

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original string when the value is not URI-encoded.
  }

  return normalized;
}

function getBetterAuthCookieValue(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  const cookies = parseCookieHeader(cookieHeader);
  return normalizeCookieValue(
    cookies["better-auth.session_token"] ??
      cookies["__Secure-better-auth.session_token"] ??
      null
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function makeSignature(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function resolveSessionToken(
  signedOrRawToken: string | null
): Promise<string | null> {
  const normalizedToken = normalizeCookieValue(signedOrRawToken);
  if (!normalizedToken) return null;

  const lastDot = normalizedToken.lastIndexOf(".");
  if (lastDot <= 0) {
    return normalizedToken;
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    return normalizedToken;
  }

  const rawToken = normalizedToken.slice(0, lastDot);
  const providedSignature = normalizedToken.slice(lastDot + 1);
  const expectedSignature = await makeSignature(rawToken, secret);

  if (!constantTimeEqual(providedSignature, expectedSignature)) {
    return null;
  }

  return rawToken;
}

export async function resolveSessionTokenFromCookieHeader(
  cookieHeader: string | null
): Promise<string | null> {
  return resolveSessionToken(getBetterAuthCookieValue(cookieHeader));
}
