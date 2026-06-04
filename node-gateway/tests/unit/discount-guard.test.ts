import { describe, it, expect } from 'bun:test';
import {
  extractSpokenDiscountPercent,
  checkSpokenDiscount,
} from '../../src/services/discount-guard.js';

describe('extractSpokenDiscountPercent', () => {
  it('extracts a discount percent stated with "% off"', () => {
    expect(extractSpokenDiscountPercent('I can knock 30% off if we wrap up now')).toBe(30);
  });

  it('extracts a spelled-out "percent off"', () => {
    expect(extractSpokenDiscountPercent('haan, 15 percent off the order')).toBe(15);
  });

  it('takes the highest discount percent when several are mentioned', () => {
    expect(
      extractSpokenDiscountPercent('normally 5% off but I can do 20% off today'),
    ).toBe(20);
  });

  it('ignores percentages with no discount context (no false positives)', () => {
    expect(extractSpokenDiscountPercent('these have a 100% satisfaction guarantee')).toBeNull();
    expect(extractSpokenDiscountPercent('rated 4.7 stars by 90% of buyers')).toBeNull();
  });

  it('returns null when no percentage is spoken', () => {
    expect(extractSpokenDiscountPercent('happy to send the checkout link now')).toBeNull();
    expect(extractSpokenDiscountPercent('')).toBeNull();
  });
});

describe('checkSpokenDiscount', () => {
  it('flags a spoken discount above the absolute cap', () => {
    const r = checkSpokenDiscount('I can do 30% off for you', 10);
    expect(r.spokenPercent).toBe(30);
    expect(r.exceedsCap).toBe(true);
    expect(r.exceedsApplied).toBe(true);
  });

  it('flags speaking a higher discount than the link actually applies', () => {
    const r = checkSpokenDiscount('I can do 10% off', 5);
    expect(r.exceedsCap).toBe(false); // 10 == cap
    expect(r.exceedsApplied).toBe(true); // spoke 10, sent 5
  });

  it('does not flag a matching, within-cap discount', () => {
    const r = checkSpokenDiscount('I can do 5% off since you have been with us', 5);
    expect(r.spokenPercent).toBe(5);
    expect(r.exceedsCap).toBe(false);
    expect(r.exceedsApplied).toBe(false);
  });

  it('does not flag when no discount is spoken', () => {
    const r = checkSpokenDiscount('sending the link now', 0);
    expect(r.spokenPercent).toBeNull();
    expect(r.exceedsCap).toBe(false);
    expect(r.exceedsApplied).toBe(false);
  });
});
