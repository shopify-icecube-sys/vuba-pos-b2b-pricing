// B2B catalog pricing for the POS cart.
//
// POS ignores B2B catalogs, so we read the catalog price ourselves with
// productVariant.contextualPricing(companyLocationId) and apply
// (POS price - catalog price) as a per-unit FixedAmount line-item discount.
// All money maths is done in integer pence to avoid float rounding errors.

export const DISCOUNT_TITLE_PREFIX = 'B2B';

export interface CompanyLocationOption {
  companyLocationId: string; // gid://shopify/CompanyLocation/...
  locationName: string;
  companyName: string;
}

export interface CartLine {
  uuid: string;
  title?: string;
  quantity: number;
  price?: number; // POS unit price (store currency, ex-VAT on this store)
  variantId?: number;
  isGiftCard: boolean;
  discounts: {amount: number; discountDescription?: string}[];
}

export type LineStatus =
  | 'discount' // catalog price lower than POS price -> discount applied
  | 'same' // catalog price equals POS price -> nothing to do
  | 'higher' // catalog price higher than POS price -> can't raise via discount
  | 'no-price' // variant/catalog price not found
  | 'skipped'; // custom sale / gift card

export interface PricedLine {
  uuid: string;
  title: string;
  quantity: number;
  posPence: number | null;
  b2bPence: number | null;
  perUnitDiscountPence: number;
  status: LineStatus;
  hasOtherDiscount: boolean;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: {message: string}[];
}

async function adminGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch('shopify:admin/api/graphql.json', {
    method: 'POST',
    body: JSON.stringify({query, variables}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Shopify API error (HTTP ${res.status}) ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as GraphqlResponse<T>;
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  if (!json.data) throw new Error('Shopify API returned no data');
  return json.data;
}

const CUSTOMER_COMPANIES_QUERY = `#graphql
  query CustomerCompanies($id: ID!) {
    customer(id: $id) {
      id
      companyContactProfiles {
        company { id name }
        roleAssignments(first: 50) {
          nodes { companyLocation { id name } }
        }
      }
    }
  }
`;

interface CustomerCompaniesData {
  customer: {
    id: string;
    companyContactProfiles: {
      company: {id: string; name: string} | null;
      roleAssignments: {
        nodes: {companyLocation: {id: string; name: string} | null}[];
      };
    }[];
  } | null;
}

/** All company locations the POS customer can buy for (empty = not B2B). */
export async function getCompanyLocations(
  customerId: number,
): Promise<CompanyLocationOption[]> {
  const data = await adminGraphql<CustomerCompaniesData>(
    CUSTOMER_COMPANIES_QUERY,
    {id: `gid://shopify/Customer/${customerId}`},
  );
  const seen = new Set<string>();
  const options: CompanyLocationOption[] = [];
  for (const profile of data.customer?.companyContactProfiles ?? []) {
    for (const {companyLocation} of profile.roleAssignments.nodes) {
      if (!companyLocation || seen.has(companyLocation.id)) continue;
      seen.add(companyLocation.id);
      options.push({
        companyLocationId: companyLocation.id,
        locationName: companyLocation.name,
        companyName: profile.company?.name ?? '',
      });
    }
  }
  return options;
}

const CATALOG_PRICES_QUERY = `#graphql
  query CatalogPrices($ids: [ID!]!, $companyLocationId: ID!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        contextualPricing(context: {companyLocationId: $companyLocationId}) {
          price { amount }
          quantityPriceBreaks(first: 20) {
            nodes { minimumQuantity price { amount } }
          }
        }
      }
    }
  }
`;

interface CatalogPricesData {
  nodes: ({
    id: string;
    contextualPricing: {
      price: {amount: string};
      quantityPriceBreaks: {
        nodes: {minimumQuantity: number; price: {amount: string}}[];
      };
    } | null;
  } | null)[];
}

interface VariantPricing {
  basePence: number;
  breaks: {minimumQuantity: number; pence: number}[];
}

const toPence = (amount: string | number) => Math.round(Number(amount) * 100);

async function getCatalogPricing(
  variantIds: number[],
  companyLocationId: string,
): Promise<Map<number, VariantPricing>> {
  const result = new Map<number, VariantPricing>();
  if (!variantIds.length) return result;
  const data = await adminGraphql<CatalogPricesData>(CATALOG_PRICES_QUERY, {
    ids: variantIds.map((id) => `gid://shopify/ProductVariant/${id}`),
    companyLocationId,
  });
  for (const node of data.nodes) {
    if (!node?.contextualPricing) continue;
    const numericId = Number(node.id.split('/').pop());
    result.set(numericId, {
      basePence: toPence(node.contextualPricing.price.amount),
      breaks: node.contextualPricing.quantityPriceBreaks.nodes.map((b) => ({
        minimumQuantity: b.minimumQuantity,
        pence: toPence(b.price.amount),
      })),
    });
  }
  return result;
}

/** Catalog unit price for a quantity, honouring volume price breaks. */
function unitPenceForQuantity(pricing: VariantPricing, quantity: number) {
  let pence = pricing.basePence;
  let bestMin = 0;
  for (const b of pricing.breaks) {
    if (quantity >= b.minimumQuantity && b.minimumQuantity > bestMin) {
      bestMin = b.minimumQuantity;
      pence = b.pence;
    }
  }
  return pence;
}

const isOurDiscount = (d: {discountDescription?: string}) =>
  (d.discountDescription ?? '').startsWith(DISCOUNT_TITLE_PREFIX);

/** Work out the B2B price and per-unit discount for every cart line. */
export async function priceCartLines(
  lines: CartLine[],
  companyLocationId: string,
): Promise<PricedLine[]> {
  const variantIds = [
    ...new Set(
      lines
        .filter((l) => l.variantId && !l.isGiftCard)
        .map((l) => l.variantId as number),
    ),
  ];
  const pricing = await getCatalogPricing(variantIds, companyLocationId);

  return lines.map((line) => {
    const base = {
      uuid: line.uuid,
      title: line.title ?? 'Item',
      quantity: line.quantity,
      hasOtherDiscount: line.discounts.some((d) => !isOurDiscount(d)),
    };
    if (!line.variantId || line.isGiftCard || line.price == null) {
      return {
        ...base,
        posPence: line.price == null ? null : toPence(line.price),
        b2bPence: null,
        perUnitDiscountPence: 0,
        status: 'skipped' as const,
      };
    }
    const posPence = toPence(line.price);
    const variantPricing = pricing.get(line.variantId);
    if (!variantPricing) {
      return {
        ...base,
        posPence,
        b2bPence: null,
        perUnitDiscountPence: 0,
        status: 'no-price' as const,
      };
    }
    const b2bPence = unitPenceForQuantity(variantPricing, line.quantity);
    const diff = posPence - b2bPence;
    return {
      ...base,
      posPence,
      b2bPence,
      perUnitDiscountPence: Math.max(diff, 0),
      status: diff > 0 ? 'discount' : diff === 0 ? 'same' : 'higher',
    };
  });
}

export const formatPence = (pence: number | null, currency = 'GBP') =>
  pence == null
    ? '—'
    : new Intl.NumberFormat('en-GB', {style: 'currency', currency}).format(
        pence / 100,
      );

export const discountTitle = (location: CompanyLocationOption) =>
  `${DISCOUNT_TITLE_PREFIX} – ${location.companyName || location.locationName}`;
