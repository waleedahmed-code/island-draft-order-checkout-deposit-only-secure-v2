# Island Murphy Beds — Secure 50% Deposit Checkout

This Vercel/Next.js backend creates a Shopify Draft Order checkout that charges only the first 50% deposit. The remaining balance is billed separately by Island Murphy Beds.

## Customer flow

1. The builder displays the full configured order total.
2. It clearly displays the 50% amount due now and the remaining balance to be billed separately.
3. The checkout button includes the exact deposit amount.
4. Shopify checkout charges only the verified 50% deposit.
5. The order records the full configured total, deposit due, remaining balance, and all selected options.

## Pricing security

The backend does not trust the browser-calculated total by itself. Before creating checkout, it:

- Fetches the selected variant and current variant price from Shopify Admin GraphQL.
- Derives Beacon, Douglas, Empress, minimal, one-side, two-side, and tag-product rules from Shopify product data.
- Recalculates cabinet, horizontal orientation, paint, crown, lighting, door, and mattress pricing server-side.
- Rejects checkout if the browser total and server total do not match.
- Applies a basic per-IP rate limit to reduce automated checkout abuse.

The frontend and backend must both use this pricing schema:

```text
imb-builder-2026-07-v1
```

## Payment status

Creating a Draft Order checkout does not mean payment has been completed. Therefore, the draft uses neutral records such as:

```text
50-percent-deposit-checkout
remaining-50-manual-billing
manual-balance-required
server-price-verified
```

It does not prematurely tag the checkout as `deposit-paid-online`.

## Required Shopify API access

```text
write_draft_orders
read_products
```

`read_products` is required because the backend verifies the selected Shopify variant price and product tags before creating checkout.

## Environment variables

```text
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_API_VERSION=2026-01
DEFAULT_CURRENCY_CODE=CAD

# Use one Shopify authentication method:
SHOPIFY_ADMIN_ACCESS_TOKEN=
# or:
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=

ALLOWED_ORIGINS_CSV=https://islandmurphybeds.com,https://www.islandmurphybeds.com
```

## Deploy over the existing Vercel project

Copy the backend files into the existing repository without replacing its `.git` folder:

```powershell
git add .
git commit -m "Secure 50 percent deposit checkout pricing"
git push origin main
```

The builder continues using:

```text
https://island-draft-order-checkout-one.vercel.app/api/create-draft-order
```

## Test checklist

1. Test Beacon, Douglas, and Empress products.
2. Test vertical and horizontal products.
3. Test 15-inch and 22-inch cabinets, both single-side and both-side selections.
4. Test stain and 5% paint pricing.
5. Test crown, lighting, door, and every mattress choice.
6. Confirm the checkout merchandise subtotal is exactly 50% of the verified configured total before tax and shipping.
7. Confirm Shopify order details state that the remaining balance will be billed separately.
8. Modify a request total in browser developer tools and confirm the backend rejects it with HTTP 409.
