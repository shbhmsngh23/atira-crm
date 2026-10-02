'use client';

// ============================================================
// EmbeddedSignupCard — "Connect WhatsApp" through Meta's Embedded
// Signup popup (Settings → WhatsApp). Renders nothing unless the
// deployment has Embedded Signup configured (GET
// /api/whatsapp/embedded-signup) and the viewer can edit settings.
//
// Flow: load Facebook's JS SDK → FB.login with the signup config →
// the popup posts WA_EMBEDDED_SIGNUP messages naming the WABA and
// number the customer picked → FB.login's callback returns a one-time
// code → POST both to the server, which exchanges the code and
// connects the number.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, MessageCircle } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface SignupSettings {
  enabled: boolean;
  appId?: string;
  configId?: string;
  graphVersion?: string;
}

interface FacebookSdk {
  init(opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    opts: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** Load and initialise the SDK once per page. */
function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => reject(new Error('Could not load Facebook’s sign-in script. Check ad blockers and try again.'));
    document.body.appendChild(script);
  });
}

function isFacebookOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'facebook.com' || host.endsWith('.facebook.com');
  } catch {
    return false;
  }
}

export function EmbeddedSignupCard({ onConnected }: { onConnected: () => void }) {
  const t = useTranslations('Settings.whatsapp');
  const { canEditSettings } = useAuth();
  const [settings, setSettings] = useState<SignupSettings | null>(null);
  const [busy, setBusy] = useState(false);
  // What the popup reported (WA_EMBEDDED_SIGNUP FINISH), read when
  // FB.login's callback fires.
  const selection = useRef<{ phone_number_id?: string; waba_id?: string; cancelled?: boolean }>({});

  useEffect(() => {
    fetch('/api/whatsapp/embedded-signup', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { enabled: false }))
      .then((data: SignupSettings) => setSettings(data))
      .catch(() => setSettings({ enabled: false }));
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isFacebookOrigin(event.origin)) return;
      let data: unknown = event.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      const msg = data as { type?: string; event?: string; data?: Record<string, string> };
      if (msg?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (msg.event === 'CANCEL') {
        selection.current = { cancelled: true };
      } else if (msg.event?.startsWith('FINISH')) {
        selection.current = {
          phone_number_id: msg.data?.phone_number_id,
          waba_id: msg.data?.waba_id,
        };
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const finish = useCallback(
    async (code: string) => {
      // The popup's FINISH message usually lands before this callback;
      // give it a moment if not. The server can also work the ids out.
      for (let i = 0; i < 10 && !selection.current.waba_id; i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
      const res = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, ...selection.current, cancelled: undefined }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
        registration_error?: string;
      };
      if (!res.ok) throw new Error(payload.error || t('embeddedFailed'));
      if (payload.success === false && payload.registration_error) {
        // Saved, but /register failed (e.g. the number already has a
        // two-step PIN of its own). The page below explains next steps.
        toast.warning(payload.registration_error);
      } else {
        toast.success(t('embeddedSuccess'));
      }
      onConnected();
    },
    [onConnected, t],
  );

  async function start() {
    if (!settings?.appId || !settings.configId || !settings.graphVersion) return;
    setBusy(true);
    selection.current = {};
    try {
      const fb = await loadFacebookSdk(settings.appId, settings.graphVersion);
      fb.login(
        (response) => {
          const code = response.authResponse?.code;
          if (!code) {
            toast.message(t('embeddedCancelled'));
            setBusy(false);
            return;
          }
          finish(code)
            .catch((err: Error) => toast.error(err.message))
            .finally(() => setBusy(false));
        },
        {
          config_id: settings.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
        },
      );
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  if (!settings?.enabled || !canEditSettings) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('embeddedTitle')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('embeddedDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={() => void start()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
          {busy ? t('embeddedConnecting') : t('embeddedButton')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('embeddedOr')}</p>
      </CardContent>
    </Card>
  );
}
