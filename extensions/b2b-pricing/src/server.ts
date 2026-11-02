// Fallback for when POS direct API access returns 401.
//
// Direct API calls run as the user who logged the POS device in. If that
// user's store role doesn't include this app, Shopify answers 401 even
// though the app is installed. In that case the modal asks our own app
// server instead: it holds the app's offline token and runs the SAME
// pricing code (pricing.ts), so results are identical.
//
// The key below only lets a caller run the two read-only operations the
// server exposes (company locations for a customer, catalog prices for cart
// lines) on the allowed shop. It ships inside the extension bundle, so treat
// it as a speed bump, not a secret: rotate it (here + server .env
// POS_API_KEY) if it ever leaks.

import type {CartLine, CompanyLocationOption, PricedLine} from './pricing';

export const SERVER_URL = 'https://vubapos.icecubedev.com';
export const POS_API_KEY = '401858bdd42b7d6eca9b42503cefe62d69fcab396e16f0f1';

async function call<T>(
  shop: string,
  body: Record<string, unknown>,
): Promise<T> {
  // Sent as a CORS "simple request" (text/plain, no custom headers) so the
  // browser skips the preflight: on the client's iPad (POS 11.17) the
  // preflight got a 204 but the POST was never sent ("TypeError: Load
  // failed"). The key travels in the body instead of an X-POS-Key header.
  const res = await fetch(`${SERVER_URL}/api/pos`, {
    method: 'POST',
    headers: {'Content-Type': 'text/plain'},
    body: JSON.stringify({...body, shop, key: POS_API_KEY}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`App server error (HTTP ${res.status}) ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const serverGetCompanyLocations = (shop: string, customerId: number) =>
  call<CompanyLocationOption[]>(shop, {op: 'locations', customerId});

export const serverPriceCartLines = (
  shop: string,
  lines: CartLine[],
  companyLocationId: string,
  currency: string,
) =>
  call<PricedLine[]>(shop, {
    op: 'price',
    companyLocationId,
    currency,
    // Only the fields pricing.ts needs.
    lines: lines.map((l) => ({
      uuid: l.uuid,
      title: l.title,
      quantity: l.quantity,
      price: l.price,
      variantId: l.variantId,
      isGiftCard: l.isGiftCard,
      discounts: l.discounts.map((d) => ({
        amount: d.amount,
        discountDescription: d.discountDescription,
      })),
    })),
  });

/** True for the 401 that direct API access returns without app permission. */
export const isUnauthorized = (error: unknown) =>
  /\b401\b/.test(String(error));
