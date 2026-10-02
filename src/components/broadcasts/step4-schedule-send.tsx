'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, CalendarClock, Send, Loader2, Users, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  /**
   * '' sends now; otherwise a `datetime-local` value (the viewer's local
   * time) at which the server-side worker sends the broadcast.
   */
  scheduledAt: string;
  onScheduledAtChange: (value: string) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

/** A schedule must be at least this far ahead. */
const MIN_SCHEDULE_LEAD_MS = 2 * 60 * 1000;

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  scheduledAt,
  onScheduledAtChange,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  const [mode, setMode] = useState<'now' | 'later'>(scheduledAt ? 'later' : 'now');

  const isScheduled = mode === 'later';
  // The worker runs about once a minute, so anything sooner than a few
  // minutes out is effectively "now" and is better sent as such.
  const scheduleValid =
    !isScheduled ||
    (scheduledAt !== '' && Date.parse(scheduledAt) >= Date.now() + MIN_SCHEDULE_LEAD_MS);
  const scheduledLabel =
    isScheduled && scheduledAt ? new Date(scheduledAt).toLocaleString() : '';

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* When to send */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.when')}</p>
        <div role="radiogroup" className="flex flex-wrap gap-2">
          {(['now', 'later'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={isProcessing}
              onClick={() => {
                setMode(m);
                if (m === 'now') onScheduledAtChange('');
              }}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                mode === m
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {m === 'now' ? t('scheduleSend.now') : t('scheduleSend.later')}
            </button>
          ))}
        </div>
        {isScheduled ? (
          <div>
            <label htmlFor="broadcast-schedule-at" className="mb-1.5 block text-xs text-muted-foreground">
              {t('scheduleSend.at')}
            </label>
            <Input
              id="broadcast-schedule-at"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => onScheduledAtChange(e.target.value)}
              disabled={isProcessing}
              className="w-full border-border bg-muted text-foreground sm:w-64"
            />
            {!scheduleValid ? (
              <p className="mt-1.5 text-xs text-destructive">{t('scheduleSend.inPast')}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">
                {isScheduled ? t('scheduleSend.scheduling') : t('scheduleSend.sending')}
              </p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!name.trim() || isProcessing || !scheduleValid}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {isScheduled ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {isScheduled ? t('scheduleSend.schedule') : t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {isScheduled ? t('scheduleSend.confirmScheduleTitle') : t('scheduleSend.confirmTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {isScheduled
                  ? t.rich('scheduleSend.confirmScheduleDesc', {
                      count: estimatedReach,
                      template: template.name,
                      date: scheduledLabel,
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })
                  : t.rich('scheduleSend.confirmDesc', {
                      count: estimatedReach,
                      template: template.name,
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {isScheduled ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {isScheduled ? t('scheduleSend.schedule') : t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
