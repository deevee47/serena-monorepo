// AUTOGEN KEEPS BRAIN-API.GENERATED IN SYNC.
// Hand-edit at your own peril — `bun run gen:types` will overwrite.
// Add manually-curated TS-only shapes below the re-export block.

export * from './brain-api.generated';

// ─── /converse SSE event union ─────────────────────────────────────────────
// Emitted by POST /converse/stream. Brain-side these are TypedDicts in
// fastapi-brain/app/services/llm.py; no Pydantic model owns the union, so
// the shape lives here as the single source of truth.

export type ToolName = 'send_whatsapp_checkout_link' | 'send_whatsapp_product_info';

export type ConverseStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; tool: string }
  | { type: 'observation'; name: string; args: Record<string, unknown>; result: Record<string, unknown> }
  | { type: 'tool_call'; name: ToolName; args: Record<string, unknown> }
  | { type: 'done'; finish_reason?: string | null };
