/* eslint-disable @typescript-eslint/no-explicit-any */

let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiresAt = 0;

export type ShopifyGraphQLResult<T = any> = {
  status: number;
  json: T;
  authMode: string;
};

export function sanitizeStoreDomain(domain?: string) {
  if (!domain) return "";
  return domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function getShopifyConfig() {
  const storeDomain = sanitizeStoreDomain(process.env.SHOPIFY_STORE_DOMAIN);
  const apiVersion = (process.env.SHOPIFY_API_VERSION || "2026-01").trim();

  if (!storeDomain) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN");
  }

  return { storeDomain, apiVersion };
}

function hasClientCredentialsConfigured() {
  return Boolean(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}

function clearCachedAccessToken() {
  cachedAccessToken = null;
  cachedAccessTokenExpiresAt = 0;
}

async function fetchClientCredentialsToken(storeDomain: string) {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET");
  }

  const response = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    cache: "no-store",
  });

  const raw = await response.text();
  let data: any;

  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }

  if (!response.ok || !data?.access_token) {
    throw new Error(
      data?.error_description ||
        data?.error ||
        `Shopify token exchange failed with status ${response.status}`
    );
  }

  const expiresIn = Number(data.expires_in || 86399);
  cachedAccessToken = String(data.access_token);
  cachedAccessTokenExpiresAt = Date.now() + expiresIn * 1000;

  return cachedAccessToken;
}

async function getShopifyAccessToken(storeDomain: string) {
  if (hasClientCredentialsConfigured()) {
    if (
      cachedAccessToken &&
      Date.now() < cachedAccessTokenExpiresAt - 60_000
    ) {
      return { token: cachedAccessToken, authMode: "client_credentials_cached" };
    }

    return {
      token: await fetchClientCredentialsToken(storeDomain),
      authMode: "client_credentials_fresh",
    };
  }

  const staticToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (staticToken) {
    return { token: staticToken, authMode: "static_admin_token" };
  }

  throw new Error(
    "Missing Shopify credentials. Provide SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET, or SHOPIFY_ADMIN_ACCESS_TOKEN."
  );
}

export async function shopifyGraphQLRequest<T = any>(params: {
  query: string;
  variables?: Record<string, unknown>;
}): Promise<ShopifyGraphQLResult<T>> {
  const { storeDomain, apiVersion } = getShopifyConfig();
  let { token, authMode } = await getShopifyAccessToken(storeDomain);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query: params.query,
          variables: params.variables || {},
        }),
        cache: "no-store",
      }
    );

    const raw = await response.text();
    let json: any;

    try {
      json = JSON.parse(raw);
    } catch {
      json = { raw };
    }

    if (response.status === 401 && hasClientCredentialsConfigured() && attempt === 0) {
      clearCachedAccessToken();
      const refreshed = await getShopifyAccessToken(storeDomain);
      token = refreshed.token;
      authMode = refreshed.authMode;
      continue;
    }

    return { status: response.status, json: json as T, authMode };
  }

  throw new Error("Shopify authentication retry failed");
}

export function collectGraphQLErrors(json: any, operationResult?: any) {
  const errors: string[] = [];

  if (Array.isArray(json?.errors)) {
    errors.push(
      ...json.errors.map((error: any) => error?.message || "Unknown GraphQL error")
    );
  }

  if (Array.isArray(operationResult?.userErrors)) {
    errors.push(
      ...operationResult.userErrors.map(
        (error: any) => error?.message || "Unknown Shopify user error"
      )
    );
  }

  return errors;
}

export async function executeShopifyOperation<T = any>(params: {
  query: string;
  variables?: Record<string, unknown>;
  operationPath?: string[];
}) {
  const response = await shopifyGraphQLRequest<any>({
    query: params.query,
    variables: params.variables,
  });

  if (response.status >= 400) {
    throw new Error(`Shopify GraphQL HTTP ${response.status}`);
  }

  let operationResult: any = response.json?.data;
  for (const key of params.operationPath || []) {
    operationResult = operationResult?.[key];
  }

  const errors = collectGraphQLErrors(response.json, operationResult);
  if (errors.length) {
    throw new Error(errors.join(" | "));
  }

  return {
    data: response.json?.data as T,
    operationResult,
    authMode: response.authMode,
  };
}

export function requireBearerSecret(req: Request, envName: string) {
  const expected = process.env[envName]?.trim();

  if (!expected) {
    return { ok: false as const, status: 500, error: `Missing ${envName}` };
  }

  const authorization = req.headers.get("authorization") || "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  if (!provided || provided !== expected) {
    return { ok: false as const, status: 401, error: "Unauthorized" };
  }

  return { ok: true as const };
}

export function formatOrderGid(value: string | number) {
  const raw = String(value).trim();
  if (!raw) return "";
  return raw.startsWith("gid://shopify/Order/")
    ? raw
    : `gid://shopify/Order/${raw.replace(/^#/, "")}`;
}
