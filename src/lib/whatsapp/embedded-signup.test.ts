import { describe, expect, it } from 'vitest'

import {
  embeddedSignupConfig,
  generateRegistrationPin,
  parseSignupRequest,
  pickSingle,
  wabaIdsFromScopes,
} from './embedded-signup'

describe('embeddedSignupConfig', () => {
  it('is off until the app id, config id and secret are all set', () => {
    expect(embeddedSignupConfig({})).toBeNull()
    expect(embeddedSignupConfig({ META_APP_ID: '1', META_APP_SECRET: 's' })).toBeNull()
    expect(
      embeddedSignupConfig({
        META_APP_ID: ' 123 ',
        META_EMBEDDED_SIGNUP_CONFIG_ID: '456',
        META_APP_SECRET: 'first, second',
      }),
    ).toEqual({ appId: '123', configId: '456', appSecret: 'first' })
  })
})

describe('generateRegistrationPin', () => {
  it('always returns six digits', () => {
    for (let i = 0; i < 200; i++) expect(generateRegistrationPin()).toMatch(/^\d{6}$/)
  })
})

describe('wabaIdsFromScopes', () => {
  it('collects WABA ids from the WhatsApp scopes only, deduplicated', () => {
    expect(
      wabaIdsFromScopes([
        { scope: 'business_management', target_ids: ['999'] },
        { scope: 'whatsapp_business_management', target_ids: ['111', '222'] },
        { scope: 'whatsapp_business_messaging', target_ids: ['111'] },
        { scope: 'public_profile' },
      ]),
    ).toEqual(['111', '222'])
  })
})

describe('pickSingle', () => {
  it('returns the only item, or explains none / several', () => {
    expect(pickSingle(['a'], 'phone number')).toEqual({ value: 'a' })
    expect(pickSingle([], 'phone number')).toHaveProperty('error')
    expect(pickSingle(['a', 'b'], 'WhatsApp Business Account')).toHaveProperty('error')
  })
})

describe('parseSignupRequest', () => {
  it('requires the code and validates optional ids', () => {
    expect(parseSignupRequest({ code: 'abc', waba_id: '1234567', phone_number_id: '7654321' })).toEqual({
      code: 'abc',
      wabaId: '1234567',
      phoneNumberId: '7654321',
    })
    expect(parseSignupRequest({ code: 'abc' })).toEqual({ code: 'abc', wabaId: null, phoneNumberId: null })
    expect(parseSignupRequest({})).toHaveProperty('error')
    expect(parseSignupRequest({ code: 'abc', waba_id: '+91 98' })).toHaveProperty('error')
    expect(parseSignupRequest(null)).toHaveProperty('error')
  })
})
