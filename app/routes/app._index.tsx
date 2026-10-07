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
          In the Shopify POS app: home screen → Add tile → Apps → Apply B2B
          pricing.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
