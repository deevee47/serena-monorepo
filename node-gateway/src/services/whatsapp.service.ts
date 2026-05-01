/**
 * WhatsApp tool — DEMO IMPLEMENTATION.
 *
 * This module simulates sending WhatsApp messages without actually calling
 * the WhatsApp Business API. It logs structured events and returns a fake
 * message id so callers can verify the tool was invoked and the right data
 * was passed.
 *
 * To make it real: swap the `simulateSend` body for a fetch to the WhatsApp
 * Business API or a provider like Twilio / MessageBird. The function
 * signatures below are the contract.
 */

import { logger } from '../utils/logger.js';

export interface WhatsAppSendResult {
  delivered: boolean;
  messageId: string;
  to: string;
  kind: 'checkout_link' | 'product_info';
  // What we would have sent — useful for the demo / for assertions in tests.
  preview: string;
}

function fakeMessageId(): string {
  return `wa_demo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function simulateSend(
  to: string,
  kind: 'checkout_link' | 'product_info',
  preview: string,
): WhatsAppSendResult {
  const result: WhatsAppSendResult = {
    delivered: true,
    messageId: fakeMessageId(),
    to,
    kind,
    preview,
  };
  // Single structured log line — in real life we'd hit the WhatsApp API here.
  logger.info({ whatsapp_demo: result }, '[DEMO] WhatsApp message sent');
  return result;
}

/**
 * Send a checkout link for a product to the customer's WhatsApp.
 * In the demo, just logs and returns a fake message id.
 */
export function sendCheckoutLinkOnWhatsApp(args: {
  to: string;
  productId: string;
  productName: string;
  price: number;
  discountPercent: number;
}): WhatsAppSendResult {
  const finalPrice = args.price * (1 - args.discountPercent / 100);
  const discountTag = args.discountPercent > 0 ? ` (${args.discountPercent}% off)` : '';
  const preview =
    `Checkout — ${args.productName}${discountTag}: $${finalPrice.toFixed(2)} | ` +
    `https://shop.example/checkout/${args.productId}?d=${args.discountPercent}`;
  return simulateSend(args.to, 'checkout_link', preview);
}

/**
 * Send product details (no checkout link) so the customer can review on
 * their own time. Used after a graceful exit when we don't want to pressure.
 */
export function sendProductInfoOnWhatsApp(args: {
  to: string;
  productId: string;
  productName: string;
  price: number;
}): WhatsAppSendResult {
  const preview =
    `${args.productName} — $${args.price.toFixed(2)} | ` +
    `Details: https://shop.example/product/${args.productId} | ` +
    `Reach out anytime if you have questions.`;
  return simulateSend(args.to, 'product_info', preview);
}
