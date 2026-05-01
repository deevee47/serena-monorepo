import { describe, it, expect } from 'bun:test';
import {
  dispatchToolCall,
  MAX_DISCOUNT_PERCENT,
} from '../../src/services/converse-dispatcher.js';
import type { ConverseToolCall } from '../../src/services/brain.service.js';

const product = { id: 'prod-001', name: 'ZephyrChair Pro', price: 349.0 };
const ctx = { callId: 'c1', phoneNumber: '+15551234567', product };

describe('dispatchToolCall', () => {
  it('routes send_whatsapp_checkout_link with the supplied discount', () => {
    const tool: ConverseToolCall = {
      name: 'send_whatsapp_checkout_link',
      args: { discount_percent: 5 },
    };
    const result = dispatchToolCall(tool, ctx);
    expect(result.toolName).toBe('send_whatsapp_checkout_link');
    expect(result.appliedArgs).toEqual({ discount_percent: 5 });
    expect(result.whatsapp?.delivered).toBe(true);
    expect(result.whatsapp?.kind).toBe('checkout_link');
  });

  it('routes send_whatsapp_product_info with no args', () => {
    const tool: ConverseToolCall = { name: 'send_whatsapp_product_info', args: {} };
    const result = dispatchToolCall(tool, ctx);
    expect(result.toolName).toBe('send_whatsapp_product_info');
    expect(result.whatsapp?.kind).toBe('product_info');
  });

  it('clamps a too-high discount_percent to the max', () => {
    const tool: ConverseToolCall = {
      name: 'send_whatsapp_checkout_link',
      args: { discount_percent: 25 },
    };
    const result = dispatchToolCall(tool, ctx);
    expect(result.appliedArgs).toEqual({ discount_percent: MAX_DISCOUNT_PERCENT });
    // Preview reflects the clamped value, not the requested 25.
    expect(result.whatsapp?.preview).toContain('10% off');
  });

  it('clamps a negative discount_percent to zero', () => {
    const tool: ConverseToolCall = {
      name: 'send_whatsapp_checkout_link',
      args: { discount_percent: -3 },
    };
    const result = dispatchToolCall(tool, ctx);
    expect(result.appliedArgs).toEqual({ discount_percent: 0 });
    expect(result.whatsapp?.preview).not.toContain('% off');
  });

  it('coerces a non-numeric discount_percent to zero', () => {
    const tool: ConverseToolCall = {
      name: 'send_whatsapp_checkout_link',
      args: { discount_percent: 'lots' as unknown as number },
    };
    const result = dispatchToolCall(tool, ctx);
    expect(result.appliedArgs).toEqual({ discount_percent: 0 });
  });

  it('skips dispatch when no product is in context', () => {
    const tool: ConverseToolCall = { name: 'send_whatsapp_checkout_link', args: {} };
    const result = dispatchToolCall(tool, { ...ctx, product: null });
    expect(result.skipped?.reason).toBe('no_product_in_session');
    expect(result.whatsapp).toBeUndefined();
  });

  it('preserves the customer phone number on the whatsapp send', () => {
    const tool: ConverseToolCall = { name: 'send_whatsapp_product_info', args: {} };
    const result = dispatchToolCall(tool, { ...ctx, phoneNumber: '+447700900123' });
    expect(result.whatsapp?.to).toBe('+447700900123');
  });
});
