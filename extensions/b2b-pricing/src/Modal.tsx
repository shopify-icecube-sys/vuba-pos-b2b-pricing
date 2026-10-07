import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

import {
  type CompanyLocationOption,
  type PricedLine,
  DISCOUNT_TITLE_PREFIX,
  discountTitle,
  formatPence,
  getCompanyLocations,
  priceCartLines,
} from './pricing';

export default async () => {
  render(<Extension />, document.body);
};

type State =
  | {step: 'loading'; message: string}
  | {step: 'error'; message: string}
  | {step: 'no-customer'}
  | {step: 'no-company'}
  | {step: 'choose-location'; locations: CompanyLocationOption[]}
  | {step: 'preview'; location: CompanyLocationOption; lines: PricedLine[]};

const STATUS_BADGE: Record<
  PricedLine['status'],
  {tone: 'success' | 'neutral' | 'warning' | 'critical'; label: string}
> = {
  discount: {tone: 'success', label: 'B2B price'},
  same: {tone: 'neutral', label: 'Same price'},
  higher: {tone: 'warning', label: 'Catalog higher – not changed'},
  'no-price': {tone: 'critical', label: 'No catalog price'},
  skipped: {tone: 'neutral', label: 'Skipped'},
};

function Extension() {
  const [state, setState] = useState<State>({
    step: 'loading',
    message: 'Looking up company…',
  });
  const [applying, setApplying] = useState(false);
  const currency = shopify.session.currentSession.currency;

  async function loadPreview(location: CompanyLocationOption) {
    setState({step: 'loading', message: 'Fetching catalog prices…'});
    try {
      const lines = await priceCartLines(
        shopify.cart.current.value.lineItems,
        location.companyLocationId,
      );
      setState({step: 'preview', location, lines});
    } catch (error) {
      setState({step: 'error', message: String(error)});
    }
  }

  useEffect(() => {
    (async () => {
      const customer = shopify.cart.current.value.customer;
      if (!customer) {
        setState({step: 'no-customer'});
        return;
      }
      try {
        const locations = await getCompanyLocations(customer.id);
        if (locations.length === 0) setState({step: 'no-company'});
        else if (locations.length === 1) await loadPreview(locations[0]);
        else setState({step: 'choose-location', locations});
      } catch (error) {
        setState({step: 'error', message: String(error)});
      }
    })();
  }, []);

  async function apply(location: CompanyLocationOption, lines: PricedLine[]) {
    setApplying(true);
    try {
      const toDiscount = lines.filter((l) => l.status === 'discount');
      if (toDiscount.length) {
        await shopify.cart.bulkSetLineItemDiscounts(
          toDiscount.map((l) => ({
            lineItemUuid: l.uuid,
            lineItemDiscount: {
              title: discountTitle(location),
              type: 'FixedAmount' as const,
              // 2026-07 API: FixedAmount is per unit, so no x quantity here.
              amount: (l.perUnitDiscountPence / 100).toFixed(2),
            },
          })),
        );
      }

      // A line that had our B2B discount but no longer needs one
      // (e.g. re-applied for another location) gets it removed.
      const cartLines = shopify.cart.current.value.lineItems;
      for (const l of lines) {
        if (l.status === 'discount') continue;
        const cartLine = cartLines.find((c) => c.uuid === l.uuid);
        const hasOurs = cartLine?.discounts.some((d) =>
          (d.discountDescription ?? '').startsWith(DISCOUNT_TITLE_PREFIX),
        );
        if (hasOurs) await shopify.cart.removeLineItemDiscount(l.uuid);
      }

      await shopify.cart.addCartProperties({
        _b2b_company_location: location.companyLocationId,
      });

      shopify.toast.show(
        toDiscount.length
          ? `B2B pricing applied to ${toDiscount.length} item(s)`
          : 'No price changes needed',
      );
      window.close();
    } catch (error) {
      setApplying(false);
      setState({step: 'error', message: `Could not apply: ${String(error)}`});
    }
  }

  return (
    <s-page heading="Apply B2B pricing">
      <s-scroll-box>
        <s-box padding="base">{renderBody()}</s-box>
      </s-scroll-box>
    </s-page>
  );

  function renderBody() {
    switch (state.step) {
      case 'loading':
        return (
          <s-stack direction="block" gap="base" alignItems="center">
            <s-spinner />
            <s-text>{state.message}</s-text>
          </s-stack>
        );

      case 'error':
        // POS banners only render their heading, so the detail goes below.
        return (
          <s-stack direction="block" gap="base">
            <s-banner heading="Something went wrong" tone="critical" />
            <s-text>{state.message}</s-text>
          </s-stack>
        );

      case 'no-customer':
        return (
          <s-banner heading="No customer in cart" tone="warning">
            <s-text>Add the B2B customer to the cart, then try again.</s-text>
          </s-banner>
        );

      case 'no-company':
        return (
          <s-banner heading="Not a B2B customer" tone="info">
            <s-text>
              This customer is not linked to a company, so the normal price
              stays.
            </s-text>
          </s-banner>
        );

      case 'choose-location':
        return (
          <s-section heading="Which company location is this order for?">
            <s-choice-list
              onChange={(event) => {
                const id = event.currentTarget.values?.[0];
                const location = state.locations.find(
                  (l) => l.companyLocationId === id,
                );
                if (location) loadPreview(location);
              }}
            >
              {state.locations.map((l) => (
                <s-choice key={l.companyLocationId} value={l.companyLocationId}>
                  {l.companyName} – {l.locationName}
                </s-choice>
              ))}
            </s-choice-list>
          </s-section>
        );

      case 'preview': {
        const {location, lines} = state;
        const changes = lines.filter((l) => l.status === 'discount').length;
        return (
          <s-stack direction="block" gap="base">
            <s-section heading="Customer company">
              <s-text type="strong">{location.companyName}</s-text>
              <s-text color="subdued">{location.locationName}</s-text>
            </s-section>

            <s-section heading="Cart prices (per unit, ex VAT)">
              <s-stack direction="block" gap="base">
                {lines.map((l) => (
                  <s-stack key={l.uuid} direction="block" gap="small-200">
                    <s-text type="strong">
                      {l.title} × {l.quantity}
                    </s-text>
                    <s-text>
                      {formatPence(l.posPence, currency)} →{' '}
                      {formatPence(
                        l.status === 'discount' ? l.b2bPence : l.posPence,
                        currency,
                      )}
                    </s-text>
                    <s-badge tone={STATUS_BADGE[l.status].tone}>
                      {STATUS_BADGE[l.status].label}
                    </s-badge>
                    {l.status === 'discount' && l.hasOtherDiscount && (
                      <s-text tone="warning" type="small">
                        Replaces the existing discount on this line
                      </s-text>
                    )}
                    <s-divider />
                  </s-stack>
                ))}
              </s-stack>
            </s-section>

            <s-button
              variant="primary"
              loading={applying}
              disabled={applying}
              onClick={() => apply(location, lines)}
            >
              {changes ? `Apply B2B prices (${changes})` : 'Done'}
            </s-button>
          </s-stack>
        );
      }
    }
  }
}
