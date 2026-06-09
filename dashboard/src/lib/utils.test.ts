import { test, expect, describe } from 'bun:test';
import { deriveDefaultCallName, formatShortDate } from './utils';

const D = new Date('2026-06-09T12:00:00Z');

describe('deriveDefaultCallName', () => {
  test('weaves product name + date', () => {
    const out = deriveDefaultCallName('Egg White Protein', D);
    expect(out).toContain('Egg White Protein');
    expect(out).toContain(' — ');
  });

  test('falls back to "Call" when there is no product', () => {
    expect(deriveDefaultCallName(null, D)).toMatch(/^Call — /);
    expect(deriveDefaultCallName('', D)).toMatch(/^Call — /);
    expect(deriveDefaultCallName('   ', D)).toMatch(/^Call — /);
  });

  test('product only when there is no date', () => {
    expect(deriveDefaultCallName('Hoodie', null)).toBe('Hoodie');
  });
});

describe('formatShortDate', () => {
  test('empty for nullish', () => {
    expect(formatShortDate(null)).toBe('');
    expect(formatShortDate(undefined)).toBe('');
  });

  test('renders "Mon D"', () => {
    expect(formatShortDate(D)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});
