/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = "nodejs";

import { executeShopifyOperation } from "@/lib/shopify-admin";

const FALLBACK_ALLOWED_ORIGINS = new Set([
  "https://islandmurphybeds.com",
  "https://www.islandmurphybeds.com",
  "https://island-murphy-bed.myshopify.com",
  "https://islandmurphybeds.myshopify.com",
  "https://murphybedplace.com",
  "https://www.murphybedplace.com",
  "https://hi70xm-dw.myshopify.com",
]);

const PRICING_SCHEMA_VERSION = "imb-builder-2026-07-v1";
const HORIZONTAL_SIZE_UPCHARGE_CENTS = 20_000;
const LIGHTS_UPCHARGE_CENTS = 35_000;
const DETAILED_DOOR_UPCHARGE_CENTS = 10_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 12;

type RequestBody = {
  variantId?: string | number;
  variantID?: string | number;
  quantity?: string | number;
  pricingSchemaVersion?: string;
  customizationPriceCents?: string | number;
  basePriceCents?: string | number;
  horizontalSizeUpchargeCents?: string | number;
  fullOrderTotalCents?: string | number;
  depositPercentage?: string | number;
  depositAmountCents?: string | number;
  remainingBalanceCents?: string | number;
  paymentStage?: string;
  finalTotalCents?: string | number;
  properties?: Record<string, unknown>;
};

type VariantPricing = {
  id: string;
  price: string;
  product: {
    id: string;
    title: string;
    handle: string;
    tags: string[];
  };
};

type ProductRules = {
  collectionKey: "beacon" | "douglas" | "empress";
  builderMinimalTag: boolean;
  oneSideProduct: boolean;
  twoSideProduct: boolean;
  explicitTagProduct: boolean;
  minimalBuilder: boolean;
  tagProduct: boolean;
  cabinetStepHidden: boolean;
  legacyTagTwoSide: boolean;
  bothSideCabinetMode: boolean;
};

type RateLimitEntry = { count: number; resetAt: number };

declare global {
  // eslint-disable-next-line no-var
  var __imbDepositRateLimit: Map<string, RateLimitEntry> | undefined;
}

function getRateLimitStore() {
  if (!globalThis.__imbDepositRateLimit) {
    globalThis.__imbDepositRateLimit = new Map<string, RateLimitEntry>();
  }
  return globalThis.__imbDepositRateLimit;
}

function requestIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

function checkRateLimit(req: Request) {
  const store = getRateLimitStore();
  const key = requestIp(req);
  const now = Date.now();
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true as const };
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      ok: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  store.set(key, current);
  return { ok: true as const };
}

function getAllowedOrigins() {
  const csv = process.env.ALLOWED_ORIGINS_CSV?.trim();
  if (!csv) return FALLBACK_ALLOWED_ORIGINS;

  const values = csv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set(values.length ? values : Array.from(FALLBACK_ALLOWED_ORIGINS));
}

function corsHeaders(origin: string | null) {
  const headers = new Headers();

  if (origin && getAllowedOrigins().has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Vary", "Origin");
  return headers;
}

function jsonWithCors(
  req: Request,
  payload: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
) {
  const headers = corsHeaders(req.headers.get("origin"));
  headers.set("Content-Type", "application/json");
  Object.entries(extraHeaders || {}).forEach(([key, value]) => headers.set(key, value));
  return new Response(JSON.stringify(payload), { status, headers });
}

function toPositiveInt(value: unknown, fallback = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toOptionalPositiveInt(value: unknown) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toInteger(value: unknown, fallback = 0) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringifyPropertyValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function propertyValue(properties: Record<string, unknown>, key: string) {
  return stringifyPropertyValue(properties[key]).trim();
}

function normalize(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ");
}

function hasTag(tagsText: string, values: string[]) {
  return values.some((value) => tagsText.includes(value));
}

function formatVariantGid(id: string | number) {
  const raw = String(id).trim();
  if (!raw) return "";
  return raw.startsWith("gid://shopify/ProductVariant/")
    ? raw
    : `gid://shopify/ProductVariant/${raw}`;
}

function getCustomAttributes(properties: Record<string, unknown> = {}) {
  return Object.entries(properties).map(([key, value]) => ({
    key: String(key),
    value: stringifyPropertyValue(value),
  }));
}

function moneyFromCents(cents: number, currencyCode: string) {
  return { amount: (cents / 100).toFixed(2), currencyCode };
}

function formatMoney(cents: number, currencyCode: string) {
  return `${(cents / 100).toFixed(2)} ${currencyCode}`;
}

function decimalMoneyToCents(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Shopify returned an invalid variant price");
  }
  return Math.round(amount * 100);
}

function deriveProductRules(variant: VariantPricing): ProductRules {
  const title = normalize(variant.product.title);
  const handle = normalize(variant.product.handle);
  const tagsText = normalize((variant.product.tags || []).join(","));

  let collectionKey: ProductRules["collectionKey"] = "empress";
  if (title.includes("beacon") || handle.includes("beacon") || tagsText.includes("beacon")) {
    collectionKey = "beacon";
  } else if (
    title.includes("douglas") ||
    handle.includes("douglas") ||
    tagsText.includes("douglas")
  ) {
    collectionKey = "douglas";
  }

  const builderMinimalTag = hasTag(tagsText, [
    "builder_minimal",
    "builder-minimal",
    "builder minimal",
  ]);
  const oneSideProduct = hasTag(tagsText, ["one_side", "one-side", "one side"]);
  const twoSideProduct = hasTag(tagsText, ["two_side", "two-side", "two side"]);
  const explicitTagProduct = hasTag(tagsText, [
    "tag_product",
    "tag-product",
    "tag product",
  ]);
  const minimalBuilder = builderMinimalTag || oneSideProduct || twoSideProduct;
  const tagProduct = minimalBuilder || explicitTagProduct;
  const cabinetStepHidden = builderMinimalTag && !oneSideProduct && !twoSideProduct;
  const legacyTagTwoSide = explicitTagProduct && !minimalBuilder;
  const bothSideCabinetMode = !oneSideProduct && (twoSideProduct || legacyTagTwoSide);

  return {
    collectionKey,
    builderMinimalTag,
    oneSideProduct,
    twoSideProduct,
    explicitTagProduct,
    minimalBuilder,
    tagProduct,
    cabinetStepHidden,
    legacyTagTwoSide,
    bothSideCabinetMode,
  };
}

function cabinetPriceTable(collectionKey: ProductRules["collectionKey"]) {
  if (collectionKey === "empress") {
    return {
      "15": { none: 0, "no door": 129_500, "base door": 139_500, "two drawers": 159_500, "3 drawers": 179_500 },
      "22": { none: 0, "no door": 139_500, "base door": 159_500, "two drawers": 179_500, "3 drawers": 199_500 },
    };
  }

  return {
    "15": { none: 0, "no door": 79_500, "base door": 89_500, "two drawers": 109_500, "3 drawers": 119_500 },
    "22": { none: 0, "no door": 89_500, "base door": 99_500, "two drawers": 119_500, "3 drawers": 129_500 },
  };
}

function cabinetOptionPrice(
  rawName: string,
  size: "15" | "22",
  side: "left" | "right",
  rules: ProductRules
) {
  const name = normalize(rawName);
  const emptyValues = new Set(["", "not selected", "not applicable", "none"]);

  if (rules.cabinetStepHidden) {
    if (!emptyValues.has(name)) throw new Error("Cabinets are not available for this product");
    return 0;
  }

  if (emptyValues.has(name)) return 0;

  const aliases: Record<string, "no door" | "base door" | "two drawers" | "3 drawers"> = {
    "no door": "no door",
    "base door": "base door",
    "two drawers": "two drawers",
    "3 drawers": "3 drawers",
    "three drawers": "3 drawers",
  };
  const option = aliases[name];
  if (!option) throw new Error(`Unsupported ${side} cabinet option`);
  return cabinetPriceTable(rules.collectionKey)[size][option];
}

function calculateServerPrice(params: {
  basePriceCents: number;
  properties: Record<string, unknown>;
  rules: ProductRules;
}) {
  const { basePriceCents, properties, rules } = params;
  const orientationRaw = normalize(propertyValue(properties, "Orientation") || "Vertical");
  const orientation = orientationRaw === "horizontal" ? "horizontal" : "vertical";

  if (rules.minimalBuilder && orientation !== "vertical") {
    throw new Error("This product only supports vertical orientation");
  }

  const horizontalSizeUpchargeCents =
    orientation === "horizontal" && !rules.minimalBuilder
      ? HORIZONTAL_SIZE_UPCHARGE_CENTS
      : 0;

  const cabinetSizeRaw = normalize(propertyValue(properties, "Cabinet Size"));
  const cabinetSize: "15" | "22" = rules.tagProduct
    ? "15"
    : cabinetSizeRaw.startsWith("22")
      ? "22"
      : "15";

  let cabinetTotalCents = 0;
  if (orientation !== "horizontal" && !rules.cabinetStepHidden) {
    const leftCabinet = normalize(propertyValue(properties, "Left Cabinet"));
    const rightCabinet = normalize(propertyValue(properties, "Right Cabinet"));
    const cabinetEmpty = (value: string) =>
      ["", "not selected", "not applicable", "none"].includes(value);

    if (rules.oneSideProduct) {
      const leftIncluded =
        leftCabinet.includes("included side unit") && !leftCabinet.includes("units");
      const rightIncluded =
        rightCabinet.includes("included side unit") && !rightCabinet.includes("units");
      const validOneSide =
        (leftIncluded && cabinetEmpty(rightCabinet)) ||
        (rightIncluded && cabinetEmpty(leftCabinet));
      if (!validOneSide) throw new Error("Included one-side cabinet selection is invalid");
    } else if (rules.bothSideCabinetMode) {
      const leftIncluded = leftCabinet.includes("included side units");
      const rightIncluded = rightCabinet.includes("included side units");
      if (!leftIncluded || !rightIncluded) {
        throw new Error("Included two-side cabinet selection is invalid");
      }
    } else {
      cabinetTotalCents += cabinetOptionPrice(
        propertyValue(properties, "Left Cabinet"),
        cabinetSize,
        "left",
        rules
      );
      cabinetTotalCents += cabinetOptionPrice(
        propertyValue(properties, "Right Cabinet"),
        cabinetSize,
        "right",
        rules
      );
    }
  }

  const finish = normalize(propertyValue(properties, "Finish"));
  const paintCents =
    !rules.tagProduct && finish.includes("paint")
      ? Math.round((basePriceCents + cabinetTotalCents) * 0.05)
      : 0;

  const crownName = normalize(propertyValue(properties, "Crown"));
  let crownCents = 0;
  if (["", "not selected"].includes(crownName)) {
    throw new Error("A crown option must be selected");
  }
  if (crownName === "no crown") {
    if (rules.tagProduct) throw new Error("No Crown is not available for this product");
  } else if (crownName.startsWith("flat 2 1/2") || crownName === "bevelled crown") {
    crownCents = !rules.tagProduct && rules.collectionKey === "douglas" ? 20_000 : 0;
  } else {
    throw new Error("Unsupported crown option");
  }

  const lightsName = normalize(propertyValue(properties, "Lights"));
  let lightsCents = 0;
  if (lightsName === "led touch lights") lightsCents = LIGHTS_UPCHARGE_CENTS;
  else if (!["", "not selected", "no lights"].includes(lightsName)) {
    throw new Error("Unsupported lighting option");
  }

  const doorName = normalize(propertyValue(properties, "Door Style"));
  let doorCents = 0;
  if (doorName === "detailed full shaker") {
    if (rules.tagProduct) throw new Error("Detailed Full Shaker is not available for this product");
    doorCents = DETAILED_DOOR_UPCHARGE_CENTS;
  } else if (!["", "not selected", "full shaker"].includes(doorName)) {
    throw new Error("Unsupported door style");
  }

  const mattressName = normalize(propertyValue(properties, "Mattress"));
  const mattressPrices: Record<string, number> = {
    "no mattress": -30_000,
    "siesta mattress": 0,
    "zeenith mattress": 30_000,
    "zenith mattress": 30_000,
    "silverstar mattress": 50_000,
  };
  if (!(mattressName in mattressPrices)) {
    throw new Error("A valid mattress option must be selected");
  }
  const mattressCents = mattressPrices[mattressName];

  const customizationPriceCents =
    horizontalSizeUpchargeCents +
    cabinetTotalCents +
    paintCents +
    crownCents +
    lightsCents +
    doorCents +
    mattressCents;

  const fullOrderTotalCents = basePriceCents + customizationPriceCents;
  if (fullOrderTotalCents <= 0) throw new Error("Calculated order total is invalid");

  return {
    orientation,
    cabinetSize,
    basePriceCents,
    horizontalSizeUpchargeCents,
    cabinetTotalCents,
    paintCents,
    crownCents,
    lightsCents,
    doorCents,
    mattressCents,
    customizationPriceCents,
    fullOrderTotalCents,
  };
}

async function fetchVariantPricing(variantId: string) {
  const query = `
    query VariantPricing($id: ID!) {
      productVariant(id: $id) {
        id
        price
        product {
          id
          title
          handle
          tags
        }
      }
    }
  `;

  const operation = await executeShopifyOperation<any>({
    query,
    variables: { id: variantId },
    operationPath: ["productVariant"],
  });

  const variant = operation.operationResult as VariantPricing | null;
  if (!variant?.id || !variant.product) throw new Error("Selected Shopify variant was not found");
  return { variant, authMode: operation.authMode };
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: Request) {
  try {
    const origin = req.headers.get("origin");
    if (origin && !getAllowedOrigins().has(origin)) {
      return jsonWithCors(req, { ok: false, errors: ["Origin not allowed"] }, 403);
    }

    const rateLimit = checkRateLimit(req);
    if (!rateLimit.ok) {
      return jsonWithCors(
        req,
        { ok: false, errors: ["Too many checkout attempts. Please try again shortly."] },
        429,
        { "Retry-After": String(rateLimit.retryAfterSeconds) }
      );
    }

    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return jsonWithCors(req, { ok: false, errors: ["Invalid JSON body"] }, 400);
    }

    const variantId = formatVariantGid(body.variantId ?? body.variantID ?? "");
    const quantity = toPositiveInt(body.quantity, 1);
    const clientBasePriceCents = toOptionalPositiveInt(body.basePriceCents);
    const clientCustomizationPriceCents = toInteger(body.customizationPriceCents, 0);
    const clientHorizontalUpchargeCents = toInteger(body.horizontalSizeUpchargeCents, 0);
    const clientFullOrderTotalCents = toOptionalPositiveInt(body.fullOrderTotalCents);
    const clientDepositAmountCents = toOptionalPositiveInt(body.depositAmountCents);
    const clientRemainingBalanceCents = toOptionalPositiveInt(body.remainingBalanceCents);
    const requestedCheckoutTotalCents = toOptionalPositiveInt(body.finalTotalCents);
    const depositPercentage = toOptionalPositiveInt(body.depositPercentage);
    const paymentStage = String(body.paymentStage || "deposit").trim().toLowerCase();
    const pricingSchemaVersion = String(body.pricingSchemaVersion || "").trim();
    const properties =
      body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)
        ? body.properties
        : {};

    if (!variantId) return jsonWithCors(req, { ok: false, errors: ["variantId is required"] }, 400);
    if (quantity !== 1) {
      return jsonWithCors(req, { ok: false, errors: ["Only quantity 1 is supported"] }, 400);
    }
    if (paymentStage !== "deposit" || depositPercentage !== 50) {
      return jsonWithCors(
        req,
        { ok: false, errors: ["Only the 50% deposit checkout is supported"] },
        400
      );
    }
    if (pricingSchemaVersion !== PRICING_SCHEMA_VERSION) {
      return jsonWithCors(
        req,
        { ok: false, errors: ["The product builder is out of date. Please refresh the page."] },
        409
      );
    }

    const { variant, authMode } = await fetchVariantPricing(variantId);
    const rules = deriveProductRules(variant);
    const verifiedBasePriceCents = decimalMoneyToCents(variant.price);
    const verified = calculateServerPrice({
      basePriceCents: verifiedBasePriceCents,
      properties,
      rules,
    });

    const expectedDepositCents = Math.round(verified.fullOrderTotalCents * 0.5);
    const expectedRemainingCents = verified.fullOrderTotalCents - expectedDepositCents;

    const clientValuesMatch =
      clientBasePriceCents === verified.basePriceCents &&
      clientHorizontalUpchargeCents === verified.horizontalSizeUpchargeCents &&
      clientCustomizationPriceCents === verified.customizationPriceCents &&
      clientFullOrderTotalCents === verified.fullOrderTotalCents &&
      clientDepositAmountCents === expectedDepositCents &&
      clientRemainingBalanceCents === expectedRemainingCents &&
      requestedCheckoutTotalCents === expectedDepositCents;

    if (!clientValuesMatch) {
      return jsonWithCors(
        req,
        {
          ok: false,
          errors: [
            "The selected configuration price changed or could not be verified. Please refresh and try again.",
          ],
          verified_full_order_total_cents: verified.fullOrderTotalCents,
          verified_deposit_amount_cents: expectedDepositCents,
        },
        409
      );
    }

    const currencyCode = String(process.env.DEFAULT_CURRENCY_CODE || "CAD")
      .trim()
      .toUpperCase();

    const verifiedProperties = {
      ...properties,
      "Pricing Verification": "Server verified from Shopify variant and selected options",
      "Pricing Schema": PRICING_SCHEMA_VERSION,
      "Full Configured Order Total": formatMoney(verified.fullOrderTotalCents, currencyCode),
      "50% Deposit Due at Checkout": formatMoney(expectedDepositCents, currencyCode),
      "Remaining Balance To Be Billed Separately": formatMoney(
        expectedRemainingCents,
        currencyCode
      ),
      "Payment Status": "Deposit checkout created — payment not yet confirmed",
      "Manual Balance Billing Required": "Yes",
    };

    const lineItems = [
      {
        variantId,
        quantity,
        priceOverride: moneyFromCents(expectedDepositCents, currencyCode),
        customAttributes: getCustomAttributes(verifiedProperties),
      },
    ];

    const mutation = `
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            invoiceUrl
            subtotalPriceSet { presentmentMoney { amount currencyCode } }
            totalPriceSet { presentmentMoney { amount currencyCode } }
          }
          userErrors { field message }
        }
      }
    `;

    const note = [
      "50% Murphy Bed deposit checkout created; payment is not confirmed until Shopify marks the order paid.",
      `Full configured order total: ${formatMoney(verified.fullOrderTotalCents, currencyCode)}.`,
      `Due at this checkout: ${formatMoney(expectedDepositCents, currencyCode)}.`,
      `Remaining balance to be billed separately by Island Murphy Beds: ${formatMoney(expectedRemainingCents, currencyCode)}.`,
      "No automatic second invoice is scheduled by this backend.",
    ].join(" ");

    const operation = await executeShopifyOperation<any>({
      query: mutation,
      variables: {
        input: {
          lineItems,
          presentmentCurrencyCode: currencyCode,
          note,
          tags: [
            "murphy-bed",
            "50-percent-deposit-checkout",
            "remaining-50-manual-billing",
            "manual-balance-required",
            "server-price-verified",
          ],
        },
      },
      operationPath: ["draftOrderCreate"],
    });

    const draftOrder = operation.operationResult?.draftOrder;
    if (!draftOrder?.invoiceUrl) {
      throw new Error("Draft order created but Shopify did not return an invoice URL");
    }

    return jsonWithCors(req, {
      ok: true,
      invoice_url: draftOrder.invoiceUrl,
      draft_order_id: draftOrder.id,
      checkout_subtotal: draftOrder.subtotalPriceSet?.presentmentMoney?.amount || null,
      checkout_total: draftOrder.totalPriceSet?.presentmentMoney?.amount || null,
      currency_code: draftOrder.totalPriceSet?.presentmentMoney?.currencyCode || currencyCode,
      full_order_total_cents: verified.fullOrderTotalCents,
      deposit_amount_cents: expectedDepositCents,
      remaining_balance_cents: expectedRemainingCents,
      manual_balance_billing: true,
      payment_confirmed: false,
      price_verified: true,
      pricing_schema_version: PRICING_SCHEMA_VERSION,
      auth_mode: authMode || operation.authMode,
    });
  } catch (error: any) {
    console.error("Create verified 50% deposit draft order error", error);
    return jsonWithCors(
      req,
      { ok: false, errors: [error?.message || "Internal Server Error"] },
      500
    );
  }
}
