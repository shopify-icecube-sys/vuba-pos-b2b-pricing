import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function Index() {
  return (
    <s-page heading="Vuba POS B2B Pricing">
      <s-section heading="How it works">
        <s-paragraph>
          This app adds an "Apply B2B pricing" tile to Shopify POS. Staff add
          products and a customer to the cart, then tap the tile. The app looks
          up the customer's company location, reads the catalog price for each
          cart item, and applies the difference as a line-item discount.
        </s-paragraph>
        <s-paragraph>
          Prices are always read live from your B2B catalogs, so there is no
          second price list to maintain here.
        </s-paragraph>
      </s-section>
      <s-section heading="POS setup">
        <s-paragraph>
          Shopify admin → Point of Sale → Edit Point of Sale → Smart grid
          template → Add tile → Embedded Apps → vuba-pos-b2b-pricing → Save.
        </s-paragraph>
        <s-paragraph>
          The POS device must be logged in by a user whose store role includes
          access to this app (plus the POS device setup role). Otherwise the
          tile shows a 401 error.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
