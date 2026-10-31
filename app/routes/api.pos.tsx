// POST /api/pos — fallback for the POS "Apply B2B pricing" extension.
//
// POS direct API access acts as the user who logged the POS device in and
// returns 401 when that user's store role lacks this app. The extension then
// calls this route instead. It runs the same pricing code (pricing.ts) with
// the app's own offline token, so it works whoever is logged into the device.
//
// Only two read-only operations are exposed, only for shops listed in
// POS_ALLOWED_SHOPS, and only with the X-POS-Key header (POS_API_KEY).
import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { unauthenticated } from "../shopify.server";
import {
  type CartLine,
  type Gql,
  getCompanyLocations,
  priceCartLines,
} from "../../extensions/b2b-pricing/src/pricing";

const CORS_HEADERS = {
  // POS extensions call from cdn.shopify.com / extensions.shopifycdn.com.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-POS-Key",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: CORS_HEADERS });

function keyMatches(given: string | null) {
  const expected = process.env.POS_API_KEY || "";
  if (!given || !expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const allowedShops = () =>
  (process.env.POS_ALLOWED_SHOPS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// Preflight (OPTIONS) and stray GETs.
export const loader = async ({ request }: LoaderFunctionArgs) =>
  request.method === "OPTIONS"
    ? new Response(null, { status: 204, headers: CORS_HEADERS })
    : json({ error: "Method not allowed" }, 405);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (!keyMatches(request.headers.get("X-POS-Key"))) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: {
    shop?: string;
    op?: string;
    customerId?: number;
    companyLocationId?: string;
    currency?: string;
    lines?: CartLine[];
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const shop = String(body.shop || "").toLowerCase();
  if (!allowedShops().includes(shop)) {
    return json({ error: "Shop not allowed" }, 403);
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const gql: Gql = async <T,>(
      query: string,
      variables: Record<string, unknown>,
    ) => {
      const res = await admin.graphql(query, { variables });
      const payload = (await res.json()) as {
        data?: T;
        errors?: { message: string }[];
      };
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((e) => e.message).join("; "));
      }
      if (!payload.data) throw new Error("Shopify API returned no data");
      return payload.data;
    };

    if (body.op === "locations") {
      const customerId = Number(body.customerId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        return json({ error: "Invalid customerId" }, 400);
      }
      return json(await getCompanyLocations(customerId, gql));
    }

    if (body.op === "price") {
      const locationId = String(body.companyLocationId || "");
      if (!locationId.startsWith("gid://shopify/CompanyLocation/")) {
        return json({ error: "Invalid companyLocationId" }, 400);
      }
      if (!Array.isArray(body.lines) || body.lines.length > 250) {
        return json({ error: "Invalid lines" }, 400);
      }
      const currency = String(body.currency || "GBP");
      return json(await priceCartLines(body.lines, locationId, currency, gql));
    }

    return json({ error: "Unknown op" }, 400);
  } catch (error) {
    console.error("[api.pos]", error);
    return json({ error: String(error) }, 500);
  }
};
