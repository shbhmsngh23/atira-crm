// ============================================================
// /api/whatsapp/embedded-signup
//
//   GET  — whether Embedded Signup is set up on this deployment, and
//          the public ids the browser needs to open Meta's popup.
//   POST — { code, phone_number_id?, waba_id? } from the popup.
//          Exchanges the code for a business token, then connects the
//          number exactly like Settings → WhatsApp does (verify,
//          register, subscribe, save). Admin+.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { saveWhatsAppConnection } from '@/lib/whatsapp/connect'
import {
  embeddedSignupConfig,
  generateRegistrationPin,
  parseSignupRequest,
  pickSingle,
  wabaIdsFromScopes,
} from '@/lib/whatsapp/embedded-signup'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  GRAPH_API_VERSION,
  debugTokenScopes,
  exchangeSignupCode,
  listWabaPhoneNumbers,
} from '@/lib/whatsapp/meta-api'

export async function GET() {
  try {
    await getCurrentAccount()
    const config = embeddedSignupConfig()
    if (!config) return NextResponse.json({ enabled: false })
    return NextResponse.json({
      enabled: true,
      appId: config.appId,
      configId: config.configId,
      graphVersion: GRAPH_API_VERSION,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function metaError(err: unknown, message: string) {
  const detail = err instanceof Error ? err.message : 'Unknown error'
  console.error('[embedded-signup]', message, detail)
  return NextResponse.json({ error: `${message}: ${detail}` }, { status: 400 })
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const limit = await checkRateLimit(`embedded-signup:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const config = embeddedSignupConfig()
    if (!config) {
      return NextResponse.json(
        { error: 'Embedded Signup is not set up on this server.' },
        { status: 503 },
      )
    }

    const parsed = parseSignupRequest(await request.json().catch(() => null))
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

    // The code is single-use and expires in minutes; exchange it first.
    let accessToken: string
    try {
      accessToken = await exchangeSignupCode({
        appId: config.appId,
        appSecret: config.appSecret,
        code: parsed.code,
      })
    } catch (err) {
      return metaError(err, 'Meta rejected the signup code')
    }

    let wabaId = parsed.wabaId
    if (!wabaId) {
      try {
        const scopes = await debugTokenScopes({
          appId: config.appId,
          appSecret: config.appSecret,
          inputToken: accessToken,
        })
        const picked = pickSingle(wabaIdsFromScopes(scopes), 'WhatsApp Business Account')
        if ('error' in picked) return NextResponse.json({ error: picked.error }, { status: 400 })
        wabaId = picked.value
      } catch (err) {
        return metaError(err, "Couldn't read which WhatsApp Business Account was shared")
      }
    }

    let phoneNumberId = parsed.phoneNumberId
    if (!phoneNumberId) {
      try {
        const numbers = await listWabaPhoneNumbers({ wabaId, accessToken })
        const picked = pickSingle(numbers, 'phone number')
        if ('error' in picked) return NextResponse.json({ error: picked.error }, { status: 400 })
        phoneNumberId = picked.value.id
      } catch (err) {
        return metaError(err, "Couldn't list the WhatsApp Business Account's phone numbers")
      }
    }

    // Reuse the PIN this app set before for the same number (a repeat
    // signup), otherwise choose one. Meta sets it as the number's
    // two-step verification PIN on first registration.
    const { data: existing } = await ctx.supabase
      .from('whatsapp_config')
      .select('phone_number_id, registration_pin')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    let pin = generateRegistrationPin()
    if (existing?.phone_number_id === phoneNumberId && existing.registration_pin) {
      try {
        pin = decrypt(existing.registration_pin as string)
      } catch {
        // Unreadable (ENCRYPTION_KEY changed): a fresh PIN it is.
      }
    }

    return await saveWhatsAppConnection(
      ctx.supabase,
      ctx.userId,
      ctx.accountId,
      { phone_number_id: phoneNumberId, waba_id: wabaId, access_token: accessToken, pin },
      { storePin: true },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
