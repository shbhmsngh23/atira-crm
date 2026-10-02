// ============================================================
// WhatsApp Embedded Signup — connect a customer's number through
// Meta's popup instead of pasted credentials.
//
// Requires this deployment's Meta app to be an approved Tech Provider,
// and an Embedded Signup configuration created in the app dashboard
// (Facebook Login for Business → Configurations). Off until
// META_EMBEDDED_SIGNUP_CONFIG_ID is set. Setup: docs/embedded-signup.md.
// ============================================================

import { randomInt } from 'node:crypto'

import type { DebugTokenScope } from '@/lib/whatsapp/meta-api'
import { parseAppSecrets } from '@/lib/whatsapp/webhook-signature'

export interface EmbeddedSignupConfig {
  appId: string
  configId: string
  /** Secret of the app above: the first entry of META_APP_SECRET. */
  appSecret: string
}

export function embeddedSignupConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddedSignupConfig | null {
  const appId = env.META_APP_ID?.trim()
  const configId = env.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim()
  const appSecret = parseAppSecrets(env.META_APP_SECRET)[0]
  return appId && configId && appSecret ? { appId, configId, appSecret } : null
}

/** A fresh six-digit two-step verification PIN. */
export function generateRegistrationPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** WABA ids the token was granted on, from debug_token's granular scopes. */
export function wabaIdsFromScopes(scopes: DebugTokenScope[]): string[] {
  const ids = new Set<string>()
  for (const s of scopes) {
    if (s.scope === 'whatsapp_business_management' || s.scope === 'whatsapp_business_messaging') {
      for (const id of s.target_ids ?? []) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Pick the one item, or explain why we can't. The popup normally tells
 * us exactly which WABA and number the customer chose; this is the
 * fallback when it didn't (older SDK sessions, popup closed early).
 */
export function pickSingle<T>(
  items: T[],
  what: 'WhatsApp Business Account' | 'phone number',
): { value: T } | { error: string } {
  if (items.length === 1) return { value: items[0] }
  if (items.length === 0) {
    return { error: `Meta didn't return a ${what} for this signup. Run the signup again and finish every step.` }
  }
  return {
    error: `Meta returned several ${what}s for this signup, so it's unclear which one to connect. Run the signup again and pick one, or connect it by hand below.`,
  }
}

export interface SignupRequest {
  code: string
  phoneNumberId: string | null
  wabaId: string | null
}

const NUMERIC_ID = /^\d{5,30}$/

/** Validate the browser's POST body. */
export function parseSignupRequest(body: unknown): SignupRequest | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const code = typeof b.code === 'string' ? b.code.trim() : ''
  if (!code || code.length > 2000) return { error: "'code' from the signup popup is required" }

  const id = (v: unknown): string | null | false => {
    if (v === undefined || v === null || v === '') return null
    return typeof v === 'string' && NUMERIC_ID.test(v) ? v : false
  }
  const phoneNumberId = id(b.phone_number_id)
  const wabaId = id(b.waba_id)
  if (phoneNumberId === false) return { error: "'phone_number_id' must be a numeric Meta id" }
  if (wabaId === false) return { error: "'waba_id' must be a numeric Meta id" }
  return { code, phoneNumberId, wabaId }
}
