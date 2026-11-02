# Vuba POS B2B Pricing

A custom Shopify app for **Vuba Surfaces** (`vuba-resin.myshopify.com`) that applies a customer's **B2B catalog price** in **Shopify POS**.

Shopify POS ignores B2B catalogs: a company customer in a POS cart still gets the normal (retail) price. This app adds an **"Apply B2B pricing"** tile to the POS home screen. Staff add products and a customer to the cart, tap the tile, review the prices and press **Apply**. The difference between the POS price and the catalog price is applied as a per-unit line-item discount titled `B2B – <Company>`.

---

## How it works

```
POS cart (products + customer)
   │  staff taps "Apply B2B pricing"
   ▼
POS UI extension (extensions/b2b-pricing)
   │  1. POST https://vubapos.icecubedev.com/api/pos   ← server first
   │  2. if the server can't be reached: Shopify "direct API access" from the extension
   ▼
Pricing logic (extensions/b2b-pricing/src/pricing.ts – same code in both paths)
   1. customer → companyContactProfiles → company location(s)
      (several locations → staff choose one)
   2. company location → active catalogs → each catalog's price list
   3. per cart line: catalogs that include the product → MOST EXPENSIVE price wins
      (one catalog → that price; volume price breaks applied for the line quantity;
       no active catalog → fallback to Shopify contextualPricing)
   4. discount per unit = POS price − catalog price (integer pence maths)
   ▼
cart.bulkSetLineItemDiscounts (FixedAmount, per unit – API 2026-07+)
cart property _b2b_company_location = <company location GID>
```

### Business rules
- **Several catalogs on a company location** (e.g. `PT1A` + `PT1A Online Ordering`): use the **more expensive** catalog price per product. This is the client's decision of Oct 2026. Shopify's own `contextualPricing` returns the *lowest* price, so we don't use it except as a fallback.
- **One catalog**: that catalog's price.
- **Customer not linked to a company**: nothing changes. The modal shows "Not a B2B customer".
- **Catalog price higher than the POS price**: the price can't be raised with a discount. The line is left unchanged and flagged.
- POS prices on this store are **ex-VAT**, and so are the catalog prices. VAT is added by POS afterwards.
- Bundles (e.g. Cosmo) work: the discount is applied to the bundle line.

### Why the server path exists (important)
POS "direct API access" (`fetch('shopify:admin/api/graphql.json')`) runs as **the user who logged the POS device in**, not the staff member who enters a PIN. If that user's **store role** doesn't include this app, Shopify returns **401**. In Oct 2026 this kept happening on the client's iPads even after roles were changed.

So the extension calls **our server first** (`/api/pos`). The server uses the app's own **offline token** and doesn't care who is logged into the device. Direct API access is only a backup if the server is unreachable.

The extension calls the server as a **CORS simple request** (`Content-Type: text/plain`, key in the JSON body). On the client's iPad (POS 11.17) a request with a CORS preflight never sent its POST ("TypeError: Load failed"). The server echoes the exact Shopify origin and sends `Access-Control-Allow-Credentials: true`.

---

## Tech stack
| Part | Tech |
|---|---|
| App server / admin page | [React Router 7](https://reactrouter.com/) + `@shopify/shopify-app-react-router` (Shopify app template), TypeScript |
| POS extension | POS UI extension, **API 2026-07**, Preact + POS web components (`s-tile`, `s-page`, `s-banner`…) |
| Session storage | Prisma + **SQLite** (`prisma/dev.sqlite`) |
| Shopify API | Admin GraphQL (API version `July26` on the server) |
| Hosting | AWS Lightsail (shared Node apps box), PM2, Nginx reverse proxy, Let's Encrypt SSL |
| Node | **22.x** (`.nvmrc`; `engine-strict=true` in `.npmrc`, so Node 20 fails `npm install`) |
| Shopify CLI | 4.x |

---

## Project structure
```
app/
  routes/
    app._index.tsx        Admin page shown in Shopify admin (info + setup steps)
    api.pos.tsx           POST /api/pos – server path used by the POS extension
    auth.$.tsx, webhooks.*  Template auth + uninstall/scopes webhooks
  shopify.server.ts       shopifyApp() config (authenticate, unauthenticated, …)
extensions/b2b-pricing/
  shopify.extension.toml  Targets: pos.home.tile.render + pos.home.modal.render
  src/Tile.tsx            Home-screen tile (disabled until cart has items + customer)
  src/Modal.tsx           Modal: company/location, price preview, Apply button
  src/pricing.ts          ALL pricing logic (takes a `gql` caller, so it runs in the
                          extension AND on the server – app/routes/api.pos.tsx imports it)
  src/server.ts           Calls /api/pos (SERVER_URL + POS_API_KEY)
  locales/en.default.json Tile name shown in POS ("Apply B2B pricing")
shopify.app.toml          App config: client_id, URLs, scopes, webhooks
prisma/                   Session table (SQLite)
```

### Access scopes
`read_customers, read_companies, read_products, read_publications`. All are **read-only**, so the app never writes to the store. Writing to the POS cart happens through the POS Cart API, not the Admin API.
`read_publications` is needed for `product.publishedOnPublication`, which checks whether a product is in a catalog.

### `/api/pos` endpoint
- `POST` body (JSON, sent as `text/plain`): `{ key, shop, op, ... }`
  - `op: "locations"`, `customerId` → `CompanyLocationOption[]`
  - `op: "price"`, `companyLocationId`, `currency`, `lines` (≤ 250) → `PricedLine[]`
- `key` must equal env `POS_API_KEY`. The `X-POS-Key` header is also accepted for older builds.
- `shop` must be listed in env `POS_ALLOWED_SHOPS`.
- Only these two read-only operations exist.
- The key ships inside the extension bundle, so it is **not a real secret**. It limits casual access only. To rotate it, change `POS_API_KEY` in `extensions/b2b-pricing/src/server.ts` **and** in the server `.env`, then deploy both.

---

## Environment variables (server `.env`)
See `.env.example`.

| Variable | Value |
|---|---|
| `PORT` | `3010` (ports 3000–3008 are used by other apps on the box) |
| `NODE_ENV` | `production` |
| `SHOPIFY_APP_URL` | `https://vubapos.icecubedev.com` |
| `SHOPIFY_API_KEY` | App client ID (same as `client_id` in `shopify.app.toml`) |
| `SHOPIFY_API_SECRET` | Client secret (Dev Dashboard → app → Settings / Client credentials) |
| `SCOPES` | `read_customers,read_companies,read_products,read_publications` (must match the toml) |
| `POS_API_KEY` | Same value as `POS_API_KEY` in `extensions/b2b-pricing/src/server.ts` |
| `POS_ALLOWED_SHOPS` | `vuba-resin.myshopify.com` |

`react-router-serve` does **not** read `.env` by itself, so PM2 starts Node with `--env-file=.env`.

---

## Local setup
```bash
git clone https://github.com/shopify-icecube-sys/vuba-pos-b2b-pricing.git
cd vuba-pos-b2b-pricing
nvm use            # Node 22 (.nvmrc)
npm install
shopify app config link   # only if shopify.app.toml has no client_id / you need to relink
```
`shopify app dev` only offers **dev stores**, and the live store isn't one. All real testing happens on Vuba's POS after a deploy (see below).

Checks before committing:
```bash
npx tsc --noEmit                                   # app (extensions are excluded here)
(cd extensions/b2b-pricing && npx tsc -p tsconfig.json)   # extension
npm run build                                      # server build
```

---

## Making changes – which commands to run

| What you changed | What to run |
|---|---|
| **Extension only** (`extensions/b2b-pricing/**`) | `shopify app deploy` → Yes. Then **fully kill and reopen** the POS app on devices, because POS caches the old extension. |
| **Server / admin code** (`app/**`) | git push → on the server: `git pull && npm run build && pm2 restart vuba-pos-b2b-pricing` |
| **`pricing.ts`** (used by both) | **Both** of the above |
| **`shopify.app.toml`** (URLs, webhooks) | `shopify app deploy` |
| **Scopes** | Update the toml **and** `SCOPES` in the server `.env` → `shopify app deploy` → restart PM2 → a store admin must **approve** the new permissions in Vuba admin (Apps → vuba-pos-b2b-pricing) |
| **`POS_API_KEY`** | Change `server.ts` + server `.env` → deploy both |
| **`package.json` deps** | Also run `npm install` on the server before `npm run build` |

Commit messages: plain, no tool attribution. Push to `main` on `shopify-icecube-sys/vuba-pos-b2b-pricing`.

---

## Server (AWS Lightsail)
- Box: shared Node apps server (PM2 + systemd). The app lives in `~/vuba-pos-b2b-pricing`, PM2 name **`vuba-pos-b2b-pricing`**, port **3010**.
- Nginx site: `/etc/nginx/sites-available/vuba-pos-b2b-pricing` → `proxy_pass http://127.0.0.1:3010`. Certbot SSL auto-renews.
- DNS: `vubapos` A record in the icecubedev.com zone (cPanel Zone Editor) → the Lightsail IP.

First-time start (already done; only needed if the PM2 process is ever deleted):
```bash
cd ~/vuba-pos-b2b-pricing
npm install --no-audit
npx prisma generate && npx prisma migrate deploy
npm run build
pm2 start node_modules/@react-router/serve/dist/cli.js \
  --name vuba-pos-b2b-pricing \
  --interpreter "$(which node)" \
  --node-args="--env-file=.env" \
  -- ./build/server/index.js
pm2 save
```
- Make sure `which node` is Node 22.
- **Never run `pm2 update`** on this box, because systemd kills the daemon. Use `sudo systemctl restart pm2-ubuntu` if PM2 itself needs a restart.

Useful checks:
```bash
pm2 logs vuba-pos-b2b-pricing --lines 50
sudo grep "/api/pos" /var/log/nginx/access.log | tail -20   # POS calls (expect POST … 200)
curl -s -X POST https://vubapos.icecubedev.com/api/pos -d '{}'   # → {"error":"Unauthorized"} = route is live
```

---

## Shopify / POS setup (store side)
- **Distribution:** custom distribution to `vuba-resin.myshopify.com` (Partner org *Icecube Digital*).
- **Tile on the POS home screen:** Shopify admin → Point of Sale → **Edit Point of Sale** → layout icon → Smart grid template (*Smart grid 1* is the default for Capital Park, Old Melton, Sureset and Yorkshire) → **Add tile → Embedded Apps → vuba-pos-b2b-pricing** → Save.
  - The device's own "Add tile → Apps" list and the editor's "Apps" panel do **not** show it.
- **Logging a new device into POS** needs a user with the **POS device setup** role.

---

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Old behaviour after a deploy | POS caches extensions. Fully kill and reopen the POS app. |
| `Server: … \| Direct: … 401` | The server is unreachable **and** the device user lacks app access. Check `pm2 logs`, Nginx and DNS first. |
| `TypeError: Load failed` | The request was blocked before it reached the server (CORS / network). Check the nginx log for `OPTIONS` without a following `POST`. |
| "Access denied … publishedOnPublication" | The `read_publications` scope is missing or not approved in Vuba admin. |
| Price not changed, "Catalog higher" | The catalog price is above the POS price. A discount can't raise a price. |
| Modal shows "No catalog price" | The product isn't in any of the location's catalogs, or the price list has no row for it. |

Error details are shown as text **below** the red banner, because POS banners only render their heading.

---

## References
- POS UI extensions: https://shopify.dev/docs/api/pos-ui-extensions
- POS ↔ server communication: https://shopify.dev/docs/apps/build/pos/communicate-with-server
- Contextual pricing for company locations: https://shopify.dev/changelog/contextual-pricing-for-company-locations-is-now-available-for-products-in-the-graphql-admin-api
- 2026-07 per-unit fixed-amount line discounts: https://shopify.dev/changelog/pos-ui-extensions-2026-07-uses-per-unit-fixed-amount-line-item-discounts
