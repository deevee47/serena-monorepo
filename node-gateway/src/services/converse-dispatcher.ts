/**
 * Translates a ConverseToolCall from the brain into a real side effect.
 *
 * Currently routes two tools:
 *   - send_whatsapp_checkout_link → sendCheckoutLinkOnWhatsApp
 *   - send_whatsapp_product_info  → sendProductInfoOnWhatsApp
 *
 * Discount enforcement: belt-and-suspenders silent clamp on
 * `discount_percent` to [0, MAX_DISCOUNT]. The brain's tool schema and the
 * /converse route both validate first, so this clamp should only fire if
 * something upstream is broken — but it's the last line so no rogue value
 * ever reaches the WhatsApp service.
 */

import {
  sendCheckoutLinkOnWhatsApp,
  sendProductInfoOnWhatsApp,
  type WhatsAppSendResult,
} from './whatsapp.service.js';
import type { ConverseToolCall, ToolName } from './brain.service.js';
import { logger } from '../utils/logger.js';

export const MAX_DISCOUNT_PERCENT = 10;

export interface DispatchContext {
  callId: string;
  phoneNumber: string;
  product: { id: string; name: string; price: number } | null;
}

export interface DispatchResult {
  toolName: ToolName;
  appliedArgs: Record<string, unknown>;
  whatsapp?: WhatsAppSendResult;
  skipped?: { reason: string };
}

function clampDiscountPercent(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.min(MAX_DISCOUNT_PERCENT, Math.max(0, n));
}

export function dispatchToolCall(
  toolCall: ConverseToolCall,
  ctx: DispatchContext,
): DispatchResult {
  if (!ctx.product) {
    logger.warn(
      { call_id: ctx.callId, tool: toolCall.name },
      'tool_dispatch_skipped: no product in session',
    );
    return {
      toolName: toolCall.name,
      appliedArgs: {},
      skipped: { reason: 'no_product_in_session' },
    };
  }

  switch (toolCall.name) {
    case 'send_whatsapp_checkout_link': {
      const discount = clampDiscountPercent(toolCall.args['discount_percent']);
      const result = sendCheckoutLinkOnWhatsApp({
        to: ctx.phoneNumber,
        productId: ctx.product.id,
        productName: ctx.product.name,
        price: ctx.product.price,
        discountPercent: discount,
      });
      return {
        toolName: toolCall.name,
        appliedArgs: { discount_percent: discount },
        whatsapp: result,
      };
    }
    case 'send_whatsapp_product_info': {
      const result = sendProductInfoOnWhatsApp({
        to: ctx.phoneNumber,
        productId: ctx.product.id,
        productName: ctx.product.name,
        price: ctx.product.price,
      });
      return {
        toolName: toolCall.name,
        appliedArgs: {},
        whatsapp: result,
      };
    }
    default: {
      // Exhaustive check — TS will complain if a new ToolName is added without
      // a corresponding case here.
      const _exhaustive: never = toolCall.name;
      logger.warn(
        { call_id: ctx.callId, tool: toolCall.name },
        'tool_dispatch_skipped: unknown tool',
      );
      return {
        toolName: _exhaustive,
        appliedArgs: {},
        skipped: { reason: 'unknown_tool' },
      };
    }
  }
}
