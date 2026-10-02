# WhatsApp Embedded Signup

Embedded Signup lets a customer connect their WhatsApp number with a
**Connect WhatsApp** button (Settings → WhatsApp) instead of copying a
Phone Number ID, WABA ID and access token out of Meta's dashboards. They
log in with Facebook in Meta's popup, choose or create a WhatsApp
Business Account (WABA) and number, and Atira CRM does the rest:

1. exchanges the popup's one-time code for a business token,
2. verifies the number and checks it belongs to the WABA,
3. registers it (with a two-step verification PIN Atira CRM chooses and
   stores encrypted, migration `047_embedded_signup.sql`),
4. subscribes the WABA to your Meta app so its webhooks reach you,
5. saves the encrypted credentials, exactly as a manual save does.

The button is hidden until it is configured. Connecting by hand keeps
working either way.

Customers pay Meta's conversation charges themselves: they add a
payment method to their own WABA in Meta Business Manager (Meta's
popup may ask for it during signup).

## Before you can turn it on

Meta only offers Embedded Signup to apps approved as **Tech Providers**
(or Solution Partners). Meta's requirements change; check its current
"Become a Tech Provider" and "Embedded Signup" documentation. At the
time of writing, broadly:

1. Business verification of your Meta Business portfolio.
2. A Meta app (type Business) with the WhatsApp product, whose webhook
   already points at `https://<your-domain>/api/whatsapp/webhook`
   (see `docs/multi-waba.md`).
3. App review / advanced access for `whatsapp_business_management`,
   `whatsapp_business_messaging` and `business_management`.
4. Completing the Tech Provider onboarding in the app dashboard.

Start early: review and verification can take weeks.

## Setup

1. In the Meta app dashboard, **Facebook Login for Business →
   Configurations → Create configuration**, choose the WhatsApp
   Embedded Signup variation, and copy its **Configuration ID**.
2. In **Facebook Login for Business → Settings**, add your domain under
   *Allowed domains for the JavaScript SDK* and turn on *Login with the
   JavaScript SDK*.
3. Set the environment variables (see `.env.local.example`):

   ```
   META_APP_ID=<the app's id>
   META_APP_SECRET=<the same app's secret, first if you list several>
   META_EMBEDDED_SIGNUP_CONFIG_ID=<configuration id from step 1>
   ```

4. Redeploy. Admins and owners now see **Connect with Facebook** at the
   top of Settings → WhatsApp.

## When something goes wrong

- **"Meta rejected the signup code"**: the app secret doesn't match
  `META_APP_ID`, or the code expired (it is single-use and lasts
  minutes). Run the signup again.
- **"…several WhatsApp Business Accounts / phone numbers…"**: Meta's
  popup didn't report which one was picked and the token covers more
  than one. Run the signup again and finish every step, or connect by
  hand.
- **Saved but not registered**: the number already had a two-step
  verification PIN of its own (common when moving a number from another
  provider). Enter that PIN in the manual form on the same page, or
  remove the PIN in WhatsApp Manager and run the signup again.
- The browser console blocks `connect.facebook.net`: an ad or tracker
  blocker. Allow it for your Atira CRM domain.
