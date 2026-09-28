export type PromoSnapshot = { promoType: "PERCENT" | "FIXED" | null; promoValue: number | null };

/** Peso amount a promo takes off `base` (order subtotal after item discounts). Computed on
 * read from the order's snapshotted type/value rather than stored, so it stays correct if
 * items are added or edited after intake. Never exceeds base, so finalPrice can't go negative. */
export function promoDiscountAmount(base: number, promo: PromoSnapshot): number {
  if (!promo.promoType || promo.promoValue == null || base <= 0) return 0;
  const raw = promo.promoType === "PERCENT" ? (base * promo.promoValue) / 100 : promo.promoValue;
  return Math.round(Math.min(raw, base) * 100) / 100;
}
