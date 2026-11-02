# Changelog – Vuba POS B2B Pricing

## 2026-11-02
- The modal now calls the **app server first** (`/api/pos`). Shopify direct API access is only a backup. This makes pricing independent of which user logged the POS device in.
- Fixed the server path on iPad ("TypeError: Load failed"):
  - The extension sends a CORS simple request (`text/plain`, key in the body), so there is no preflight.
  - The server echoes the Shopify origin with `Access-Control-Allow-Credentials: true`.
- The error text now shows both the server and the direct-API error when both fail.

## 2026-10-31
- Added the server endpoint `POST /api/pos` (`app/routes/api.pos.tsx`), which uses the app's offline token.
  - Two read-only operations: `locations` and `price`.
  - Requires `POS_API_KEY` and a shop listed in `POS_ALLOWED_SHOPS`.
- `pricing.ts` functions now take a `gql` caller, so the same code runs in the extension and on the server.

## 2026-10-15
- **Most expensive catalog wins** when a company location has several catalogs (e.g. PT1A + PT1A Online Ordering).
  - Per-catalog prices come from `companyLocation.catalogs` → `priceList.prices`.
  - Catalog membership is checked with `product.publishedOnPublication`.
  - `contextualPricing` is kept only as a fallback.
- The modal shows which catalog each price came from.
- Added the `read_publications` scope.

## 2026-10-07
- Production hosting at `https://vubapos.icecubedev.com` (AWS Lightsail, PM2, Nginx, SSL).
- Custom distribution to `vuba-resin.myshopify.com`. The tile is added to the POS smart grid via Edit Point of Sale → Embedded Apps.
- Error messages are shown below the POS banner.
- Admin page replaced with app info and setup steps.

## 2026-10-06
- First version: POS UI extension (tile + modal, API 2026-07).
  - Applies the B2B catalog price as a per-unit line-item discount.
  - Lets staff pick a location when the customer has several.
  - Handles volume price breaks.
- Stripped the template's demo metafield/metaobject definitions and write scopes. Scopes are read-only.
