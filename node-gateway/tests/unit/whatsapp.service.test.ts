import { describe, it, expect } from 'bun:test';
import {
  sendCheckoutLinkOnWhatsApp,
  sendProductInfoOnWhatsApp,
} from '../../src/services/whatsapp.service.js';

describe('sendCheckoutLinkOnWhatsApp', () => {
  it('returns delivered=true and a fake message id', () => {
    const result = sendCheckoutLinkOnWhatsApp({
      to: '+15551234567',
      productId: 'prod-001',
      productName: 'ZephyrChair Pro',
      price: 349,
      discountPercent: 10,
    });
    expect(result.delivered).toBe(true);
    expect(result.messageId).toMatch(/^wa_demo_/);
    expect(result.kind).toBe('checkout_link');
    expect(result.to).toBe('+15551234567');
  });

  it('applies the discount percent to the price in the preview', () => {
    const result = sendCheckoutLinkOnWhatsApp({
      to: '+1',
      productId: 'p',
      productName: 'X',
      price: 100,
      discountPercent: 10,
    });
    expect(result.preview).toContain('$90.00');
    expect(result.preview).toContain('10% off');
  });

  it('omits the discount tag when no discount is given', () => {
    const result = sendCheckoutLinkOnWhatsApp({
      to: '+1',
      productId: 'p',
      productName: 'X',
      price: 100,
      discountPercent: 0,
    });
    expect(result.preview).toContain('$100.00');
    expect(result.preview).not.toContain('% off');
  });

  it('includes a checkout URL with productId in the preview', () => {
    const result = sendCheckoutLinkOnWhatsApp({
      to: '+1',
      productId: 'prod-XYZ',
      productName: 'Whatever',
      price: 49.99,
      discountPercent: 5,
    });
    expect(result.preview).toContain('checkout/prod-XYZ');
    expect(result.preview).toContain('d=5');
  });
});

describe('sendProductInfoOnWhatsApp', () => {
  it('returns delivered=true and the right kind', () => {
    const result = sendProductInfoOnWhatsApp({
      to: '+15551234567',
      productId: 'prod-002',
      productName: 'ZephyrChair Lite',
      price: 199,
    });
    expect(result.delivered).toBe(true);
    expect(result.kind).toBe('product_info');
    expect(result.preview).toContain('ZephyrChair Lite');
    expect(result.preview).toContain('$199.00');
  });
});
