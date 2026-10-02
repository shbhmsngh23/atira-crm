"use client";

// ============================================================
// WorkspaceSwitcher — move between the workspaces you belong to
// (migration 046), create a new one (e.g. an agency adding a client),
// or leave one you don't own.
//
// Every switch ends in a full page load: queries, realtime channels
// and the cached profile in this tab all belong to the old workspace.
// ============================================================

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2, LogOut, Plus, UsersRound } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Workspace {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((payload.error as string) || `Request failed (${res.status})`);
  return payload;
}

export function WorkspaceSwitcher({ roleChip }: { roleChip?: ReactNode }) {
  const t = useTranslations("WorkspaceSwitcher");
  const { account, accountRole, accountStatus } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const load = useCallback(() => {
    fetch("/api/account/workspaces", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { workspaces?: Workspace[] } | null) => {
        if (data?.workspaces) setWorkspaces(data.workspaces);
      })
      .catch(() => {
        // The current workspace still shows from the auth context.
      });
  }, []);

  useEffect(() => {
    if (accountStatus === "ready") load();
  }, [accountStatus, load]);

  // A full load on purpose (not router.push): nothing from the old
  // workspace may survive in this tab.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  const goHome = () => window.location.assign("/dashboard");

  async function switchTo(id: string) {
    setBusy(true);
    try {
      await post("/api/account/workspaces/switch", { account_id: id });
      goHome();
    } catch (err) {
      toast.error((err as Error).message || t("switchFailed"));
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    try {
      await post("/api/account/workspaces", { name: newName.trim() });
      goHome();
    } catch (err) {
      toast.error((err as Error).message || t("createFailed"));
      setBusy(false);
    }
  }

  async function leave() {
    if (!account) return;
    setBusy(true);
    try {
      await post("/api/account/workspaces/leave", { account_id: account.id });
      goHome();
    } catch (err) {
      toast.error((err as Error).message || t("leaveFailed"));
      setBusy(false);
    }
  }

  if (!account) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          className="mb-2 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60"
        >
          {busy ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <UsersRound className="size-3.5 shrink-0" />
          )}
          <span className="truncate font-medium text-foreground" title={account.name}>
            {account.name}
          </span>
          {roleChip}
          <ChevronsUpDown className="ml-auto size-3.5 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          className="max-h-80 min-w-56 overflow-y-auto bg-popover text-popover-foreground ring-border"
        >
          {/* GroupLabel throws without a Group ancestor (issue #336). */}
          <DropdownMenuGroup>
          <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
          {(workspaces ?? [{ id: account.id, name: account.name, role: accountRole ?? "", active: true }]).map(
            (w) => (
              <DropdownMenuItem
                key={w.id}
                disabled={w.active}
                onClick={() => void switchTo(w.id)}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <Check className={`size-4 ${w.active ? "opacity-100" : "opacity-0"}`} />
                <span className="truncate">{w.name}</span>
              </DropdownMenuItem>
            ),
          )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setNewName("");
              setCreateOpen(true);
            }}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <Plus className="size-4" />
            {t("create")}
          </DropdownMenuItem>
          {accountRole && accountRole !== "owner" ? (
            <DropdownMenuItem
              onClick={() => setLeaveOpen(true)}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <LogOut className="size-4" />
              {t("leave")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) void create();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("createTitle")}</DialogTitle>
              <DialogDescription>{t("createDesc")}</DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-1.5">
              <Label htmlFor="new-workspace-name">{t("nameLabel")}</Label>
              <Input
                id="new-workspace-name"
                value={newName}
                maxLength={80}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy || !newName.trim()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("createButton")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("leaveTitle", { name: account.name })}</DialogTitle>
            <DialogDescription>{t("leaveDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeaveOpen(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void leave()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("leaveConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
