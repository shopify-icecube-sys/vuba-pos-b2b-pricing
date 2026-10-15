// B2B catalog pricing for the POS cart.
//
// POS ignores B2B catalogs, so we read the company location's catalog prices
// ourselves (most expensive catalog wins, see below) and apply
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
  catalogTitle: string | null; // catalog the B2B price came from
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

// ---------------------------------------------------------------------------
// Catalog pricing
//
// Business rule (agreed with Vuba, Oct 2026): when a company location has more
// than one catalog (e.g. "PT1A" + "PT1A Online Ordering"), use the price from
// the MORE EXPENSIVE catalog. With a single catalog, use that catalog's price.
// A catalog only counts for a product if the product is published to it.
// (Shopify's own contextualPricing returns the LOWEST price, so it is only used
// as a fallback when the location has no usable catalog.)
// ---------------------------------------------------------------------------

interface PriceBreak {
  minimumQuantity: number;
  pence: number;
}

/** One catalog's price for a variant. */
interface CatalogOption {
  catalogTitle: string;
  basePence: number;
  breaks: PriceBreak[];
}

const toPence = (amount: string | number) => Math.round(Number(amount) * 100);

/** Unit price for a quantity, honouring volume price breaks. */
function unitPenceForQuantity(
  basePence: number,
  breaks: PriceBreak[],
  quantity: number,
) {
  let pence = basePence;
  let bestMin = 0;
  for (const b of breaks) {
    if (quantity >= b.minimumQuantity && b.minimumQuantity > bestMin) {
      bestMin = b.minimumQuantity;
      pence = b.pence;
    }
  }
  return pence;
}

const LOCATION_CATALOGS_QUERY = `#graphql
  query LocationCatalogs($id: ID!) {
    companyLocation(id: $id) {
      catalogs(first: 20) {
        nodes {
          id
          title
          status
          priceList { id currency }
          publication { id }
        }
      }
    }
  }
`;

interface LocationCatalogsData {
  companyLocation: {
    catalogs: {
      nodes: {
        id: string;
        title: string;
        status: string;
        priceList: {id: string; currency: string} | null;
        publication: {id: string} | null;
      }[];
    };
  } | null;
}

interface RawPrice {
  variant: {id: string};
  price: {amount: string};
  quantityPriceBreaks: {
    nodes: {minimumQuantity: number; price: {amount: string}}[];
  };
}

const variantNumericId = (gid: string) => Number(gid.split('/').pop());

/**
 * Per variant: the price in every active catalog of the location that
 * includes the product. Returns null when the location has no active catalog
 * (caller then falls back to contextualPricing).
 */
async function getPerCatalogPricing(
  variantIds: number[],
  companyLocationId: string,
  currency: string,
): Promise<Map<number, CatalogOption[]> | null> {
  const catalogData = await adminGraphql<LocationCatalogsData>(
    LOCATION_CATALOGS_QUERY,
    {id: companyLocationId},
  );
  const catalogs = (catalogData.companyLocation?.catalogs.nodes ?? []).filter(
    (c) =>
      c.status === 'ACTIVE' &&
      (!c.priceList || c.priceList.currency === currency),
  );
  if (!catalogs.length) return null;

  // One query: variant base prices + "is the product in catalog i?" + each
  // catalog's price-list prices for the cart variants. Aliases c0, c1... per
  // catalog; IDs go in as variables.
  const varDefs = ['$ids: [ID!]!'];
  const vars: Record<string, unknown> = {
    ids: variantIds.map((id) => `gid://shopify/ProductVariant/${id}`),
  };
  if (catalogs.some((c) => c.priceList)) {
    // GraphQL rejects declared-but-unused variables, so only add $q when a
    // price list block will use it.
    varDefs.push('$q: String!');
    vars.q = variantIds.map((id) => `variant_id:${id}`).join(' OR ');
  }
  const publishedFields: string[] = [];
  const priceListFields: string[] = [];
  catalogs.forEach((c, i) => {
    if (c.publication) {
      varDefs.push(`$pub${i}: ID!`);
      vars[`pub${i}`] = c.publication.id;
      publishedFields.push(`p${i}: publishedOnPublication(publicationId: $pub${i})`);
    }
    if (c.priceList) {
      varDefs.push(`$pl${i}: ID!`);
      vars[`pl${i}`] = c.priceList.id;
      priceListFields.push(`
        c${i}: priceList(id: $pl${i}) {
          prices(first: 250, query: $q) {
            nodes {
              variant { id }
              price { amount }
              quantityPriceBreaks(first: 20) {
                nodes { minimumQuantity price { amount } }
              }
            }
          }
        }`);
    }
  });

  const query = `#graphql
    query PerCatalogPrices(${varDefs.join(', ')}) {
      variants: nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price
          product { id ${publishedFields.join(' ')} }
        }
      }
      ${priceListFields.join('\n')}
    }
  `;

  type Data = {
    variants: ({
      id: string;
      price: string;
      product: Record<string, unknown>;
    } | null)[];
  } & Record<string, {prices: {nodes: RawPrice[]}} | unknown>;

  const data = await adminGraphql<Data>(query, vars);

  // catalog index -> variant id -> price row
  const rowsByCatalog = catalogs.map((_, i) => {
    const rows = new Map<number, RawPrice>();
    const block = data[`c${i}`] as {prices: {nodes: RawPrice[]}} | undefined;
    for (const row of block?.prices.nodes ?? []) {
      rows.set(variantNumericId(row.variant.id), row);
    }
    return rows;
  });

  const result = new Map<number, CatalogOption[]>();
  for (const variant of data.variants) {
    if (!variant) continue;
    const variantId = variantNumericId(variant.id);
    const options: CatalogOption[] = [];
    catalogs.forEach((catalog, i) => {
      // Product must be published to the catalog (if it has a publication).
      if (catalog.publication && variant.product[`p${i}`] !== true) return;
      const row = rowsByCatalog[i].get(variantId);
      if (row) {
        options.push({
          catalogTitle: catalog.title,
          basePence: toPence(row.price.amount),
          breaks: row.quantityPriceBreaks.nodes.map((b) => ({
            minimumQuantity: b.minimumQuantity,
            pence: toPence(b.price.amount),
          })),
        });
      } else if (!catalog.priceList) {
        // Catalog without a price list sells at the normal variant price.
        options.push({
          catalogTitle: catalog.title,
          basePence: toPence(variant.price),
          breaks: [],
        });
      }
      // Price list exists but returned no row for this variant: skip it
      // rather than guess.
    });
    result.set(variantId, options);
  }
  return result;
}

// Fallback: Shopify's resolved price for the location (lowest across catalogs).
const CONTEXTUAL_PRICES_QUERY = `#graphql
  query ContextualPrices($ids: [ID!]!, $companyLocationId: ID!) {
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

interface ContextualPricesData {
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

async function getContextualPricing(
  variantIds: number[],
  companyLocationId: string,
): Promise<Map<number, CatalogOption[]>> {
  const data = await adminGraphql<ContextualPricesData>(
    CONTEXTUAL_PRICES_QUERY,
    {
      ids: variantIds.map((id) => `gid://shopify/ProductVariant/${id}`),
      companyLocationId,
    },
  );
  const result = new Map<number, CatalogOption[]>();
  for (const node of data.nodes) {
    if (!node?.contextualPricing) continue;
    result.set(variantNumericId(node.id), [
      {
        catalogTitle: 'Catalog',
        basePence: toPence(node.contextualPricing.price.amount),
        breaks: node.contextualPricing.quantityPriceBreaks.nodes.map((b) => ({
          minimumQuantity: b.minimumQuantity,
          pence: toPence(b.price.amount),
        })),
      },
    ]);
  }
  return result;
}

const isOurDiscount = (d: {discountDescription?: string}) =>
  (d.discountDescription ?? '').startsWith(DISCOUNT_TITLE_PREFIX);

/** Work out the B2B price and per-unit discount for every cart line. */
export async function priceCartLines(
  lines: CartLine[],
  companyLocationId: string,
  currency: string,
): Promise<PricedLine[]> {
  const variantIds = [
    ...new Set(
      lines
        .filter((l) => l.variantId && !l.isGiftCard)
        .map((l) => l.variantId as number),
    ),
  ];
  const pricing = variantIds.length
    ? ((await getPerCatalogPricing(variantIds, companyLocationId, currency)) ??
      (await getContextualPricing(variantIds, companyLocationId)))
    : new Map<number, CatalogOption[]>();

  return lines.map((line) => {
    const base = {
      uuid: line.uuid,
      title: line.title ?? 'Item',
      quantity: line.quantity,
      hasOtherDiscount: line.discounts.some((d) => !isOurDiscount(d)),
      catalogTitle: null as string | null,
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
    const options = pricing.get(line.variantId) ?? [];
    if (!options.length) {
      return {
        ...base,
        posPence,
        b2bPence: null,
        perUnitDiscountPence: 0,
        status: 'no-price' as const,
      };
    }
    // Most expensive catalog wins (for this line's quantity).
    let chosen = options[0];
    let b2bPence = -1;
    for (const option of options) {
      const pence = unitPenceForQuantity(
        option.basePence,
        option.breaks,
        line.quantity,
      );
      if (pence > b2bPence) {
        b2bPence = pence;
        chosen = option;
      }
    }
    const diff = posPence - b2bPence;
    return {
      ...base,
      catalogTitle: chosen.catalogTitle,
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
