import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [cart, setCart] = useState(shopify.cart.current.value);

  useEffect(() => shopify.cart.current.subscribe(setCart), []);

  const hasItems = cart.lineItems.length > 0;
  const hasCustomer = Boolean(cart.customer);

  let subheading = 'Tap to apply catalog prices';
  if (!hasItems) subheading = 'Add products to the cart';
  else if (!hasCustomer) subheading = 'Add a customer to the cart';

  return (
    <s-tile
      heading="Apply B2B pricing"
      subheading={subheading}
      disabled={!hasItems || !hasCustomer}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
