import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from './razorpay';

const SECRET = 'whsec_test';
const BODY = '{"event":"subscription.activated"}';
const GOOD = createHmac('sha256', SECRET).update(BODY).digest('hex');

describe('verifyWebhookSignature', () => {
  it('accepts the HMAC of the raw body', () => {
    expect(verifyWebhookSignature(BODY, GOOD, SECRET)).toBe(true);
    expect(verifyWebhookSignature(BODY, ` ${GOOD.toUpperCase()} `, SECRET)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, or a missing header', () => {
    expect(verifyWebhookSignature(`${BODY} `, GOOD, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, GOOD, 'other')).toBe(false);
    expect(verifyWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, 'abc', SECRET)).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    expect(verifyWebhookSignature(BODY, GOOD, '')).toBe(false);
  });
});
