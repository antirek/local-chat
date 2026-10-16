/**
 * Apply Chat3 WatchUpdates payloads to local dialog/message state
 * without refetching GET /dialogs or messages?page=1.
 *
 * uiTarget (from data.context) is the primary router; source_event_type is fallback.
 */

export type DialogRow = {
  dialogId: string;
  unreadCount?: number;
  lastMessage?: {
    messageId?: string;
    content?: string;
    senderId?: string;
    createdAt?: number;
    type?: string;
  } | null;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type MessageRow = {
  messageId: string;
  dialogId?: string;
  senderId: string;
  content?: string;
  type?: string;
  createdAt?: number;
  deleted?: boolean;
  senderName?: string;
  statuses?: Array<{
    userId?: string;
    status?: string;
    createdAt?: number;
    readAt?: number;
  }>;
};

export type TypingState = {
  dialogId: string;
  userId: string;
  name: string;
  expiresAt: number;
};

export type ApplyCtx = {
  myLogin: string | undefined;
  selectedId: string | null;
  dialogs: DialogRow[];
  messages: MessageRow[];
  /** Current list filter — only reorder/prepend in "all". */
  dialogListFilter: string;
  totalUnreadCount: number;
  typing: TypingState | null;
};

export type ApplyResult = {
  dialogs?: DialogRow[];
  messages?: MessageRow[];
  totalUnreadCount?: number;
  typing?: TypingState | null;
  /** True when payload could not be applied and a soft list refresh is warranted. */
  needsDialogRefresh?: boolean;
  /** Scroll chat list if selected moved up. */
  selectedMovedUp?: boolean;
};

function pickDialogId(update: any, data: any): string | null {
  return (
    data?.dialog?.dialogId ||
    data?.dialog?.dialog_id ||
    data?.message?.dialogId ||
    data?.message?.dialog_id ||
    data?.typing?.dialogId ||
    data?.context?.dialogId ||
    (typeof update?.entity_id === 'string' && update.entity_id.startsWith('dlg_')
      ? update.entity_id
      : null) ||
    null
  );
}

function senderNameFrom(message: any): string | undefined {
  const meta = message?.senderInfo?.meta || message?.sender_info?.meta;
  if (meta?.name) return String(meta.name);
  return message?.senderInfo?.name || message?.sender_info?.name || message?.senderId;
}

function bumpDialogToTop(
  dialogs: DialogRow[],
  dialogId: string,
  patch: Partial<DialogRow>
): { dialogs: DialogRow[]; movedUp: boolean } {
  const idx = dialogs.findIndex((d) => d.dialogId === dialogId);
  if (idx < 0) {
    // Unknown dialog — caller may soft-refresh.
    return { dialogs, movedUp: false };
  }
  const prev = dialogs[idx];
  const next: DialogRow = { ...prev, ...patch, dialogId };
  if (idx === 0) {
    const copy = dialogs.slice();
    copy[0] = next;
    return { dialogs: copy, movedUp: false };
  }
  const rest = dialogs.filter((d) => d.dialogId !== dialogId);
  return { dialogs: [next, ...rest], movedUp: true };
}

function pickUnreadCount(...sources: Array<Record<string, unknown> | null | undefined>): number | undefined {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const raw = (src as any).unreadCount ?? (src as any).unread_count;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
  }
  return undefined;
}

function patchUnread(
  dialogs: DialogRow[],
  dialogId: string,
  unreadCount: number,
  dialogListFilter = 'all'
): DialogRow[] {
  // Unanswered view is unread>0 — drop rows that no longer qualify.
  if (dialogListFilter === 'unanswered' && unreadCount <= 0) {
    return dialogs.filter((d) => d.dialogId !== dialogId);
  }
  const idx = dialogs.findIndex((d) => d.dialogId === dialogId);
  if (idx < 0) return dialogs;
  if (dialogs[idx].unreadCount === unreadCount) return dialogs;
  const copy = dialogs.slice();
  copy[idx] = { ...copy[idx], unreadCount };
  return copy;
}

function upsertStatus(
  statuses: MessageRow['statuses'] = [],
  userId: string,
  status: string
): MessageRow['statuses'] {
  const next = statuses.filter((s) => s.userId !== userId);
  next.push({ userId, status });
  return next;
}

function applyStatusToMessages(
  messages: MessageRow[],
  messageId: string,
  statusUpdate: { userId?: string; status?: string } | null | undefined,
  matrix?: Array<{ userId?: string; status?: string; count?: number }> | null
): MessageRow[] | undefined {
  const idx = messages.findIndex((m) => m.messageId === messageId);
  if (idx < 0) return undefined;
  const msg = messages[idx];
  let statuses = msg.statuses ? [...msg.statuses] : [];
  // Prefer per-user statusUpdate. Chat3 statusMessageMatrix is often aggregated
  // ({count,userType,status}) without userId — must not wipe peer ticks.
  if (statusUpdate?.userId && statusUpdate.status) {
    statuses = upsertStatus(statuses, String(statusUpdate.userId), String(statusUpdate.status));
  } else {
    const perUser = Array.isArray(matrix)
      ? matrix.filter((s) => s && s.userId && s.status)
      : [];
    if (!perUser.length) return undefined;
    for (const s of perUser) {
      statuses = upsertStatus(statuses, String(s.userId), String(s.status));
    }
  }
  const copy = messages.slice();
  copy[idx] = { ...msg, statuses };
  return copy;
}

function applyTyping(data: any, dialogId: string | null, myLogin?: string): TypingState | null {
  const typing = data?.typing;
  if (!typing || !dialogId) return null;
  const userId = String(typing.userId || '');
  if (!userId || userId === myLogin) return null;
  const expiresInMs = Number(typing.expiresInMs || typing.expires_in_ms || 5000);
  const name =
    typing.userInfo?.meta?.name ||
    typing.userInfo?.name ||
    userId;
  return {
    dialogId,
    userId,
    name: String(name),
    expiresAt: Date.now() + Math.max(1000, expiresInMs)
  };
}

/**
 * Pure reducer: given one chat3.update payload + ctx, return state patches.
 */
export function applyChat3Update(update: any, ctx: ApplyCtx): ApplyResult {
  const source = String(update?.source_event_type || update?.sourceEventType || '');
  const updateType = String(update?.update_type || update?.updateType || '');
  const data = update?.data || {};
  const uiTarget = String(data?.context?.uiTarget || '');
  const dialogId = pickDialogId(update, data);

  if (
    source === 'connection.established' ||
    source === 'watch.ack' ||
    source === 'unwatch.ack' ||
    source === 'watch.error'
  ) {
    return {};
  }

  // --- Typing ---
  if (source === 'dialog.typing' || data.typing) {
    const typing = applyTyping(data, dialogId, ctx.myLogin);
    // Only surface for the open dialog.
    if (typing && typing.dialogId === ctx.selectedId) {
      return { typing };
    }
    if (source === 'dialog.typing') return {};
  }

  // --- Global unread (UserStatsUpdate) ---
  const stats = data?.user?.stats;
  if (stats && typeof stats.totalUnreadCount === 'number') {
    const result: ApplyResult = { totalUnreadCount: stats.totalUnreadCount };
    // user-only updates stop here
    if (updateType === 'update.user' && !data.member && !data.message) {
      return result;
    }
    // else continue — may also carry dialog patches (unusual)
  }

  // --- Message status ticks ---
  if (
    source === 'message.status.changed' ||
    source === 'message.status.update' ||
    data?.message?.statusUpdate ||
    data?.message?.statusMessageMatrix
  ) {
    const messageId = data?.message?.messageId || update?.entity_id;
    const result: ApplyResult = {};
    if (messageId && typeof messageId === 'string') {
      const patched = applyStatusToMessages(
        ctx.messages,
        messageId,
        data.message?.statusUpdate,
        data.message?.statusMessageMatrix
      );
      if (patched) result.messages = patched;
    }
    const unread = pickUnreadCount(data?.member?.state, data?.dialog?.stats);
    if (dialogId && typeof unread === 'number') {
      result.dialogs = patchUnread(ctx.dialogs, dialogId, unread, ctx.dialogListFilter);
    }
    return result;
  }

  // --- New / updated message (messages.list) ---
  if (
    (source === 'message.create' || source === 'message.update') &&
    data?.message?.messageId
  ) {
    const result: ApplyResult = {};
    const msg = data.message;
    const mid = String(msg.messageId);
    const msgDialogId = String(msg.dialogId || dialogId || '');
    const senderId = String(msg.senderId || '');

    if (msgDialogId && msgDialogId === ctx.selectedId) {
      const exists = ctx.messages.some((m) => m.messageId === mid);
      if (!exists && source === 'message.create') {
        result.messages = [
          ...ctx.messages,
          {
            messageId: mid,
            dialogId: msgDialogId,
            senderId,
            content: msg.content || '',
            type: msg.type || 'internal.text',
            // message.create payloads often omit createdAt — use now so viewport
            // read receipts can advance visibleUntil for the new message.
            createdAt: Number(msg.createdAt) || Date.now(),
            deleted: msg.deleted === true,
            senderName: senderNameFrom(msg),
            statuses: Array.isArray(msg.statuses) ? msg.statuses : []
          }
        ];
      } else if (exists && (msg.deleted === true || source === 'message.update')) {
        result.messages = ctx.messages.map((m) =>
          m.messageId === mid
            ? {
                ...m,
                content: msg.content ?? m.content,
                deleted: msg.deleted === true ? true : m.deleted,
                statuses: Array.isArray(msg.statuses) ? msg.statuses : m.statuses
              }
            : m
        );
      }
    }

    // Dialog list: last message preview + unread + bump to top (all filter only).
    if (msgDialogId) {
      const unreadRaw = pickUnreadCount(data?.member?.state, data?.dialog?.stats);
      const unread =
        typeof unreadRaw === 'number'
          ? unreadRaw
          : msgDialogId === ctx.selectedId || senderId === ctx.myLogin
            ? 0
            : (ctx.dialogs.find((d) => d.dialogId === msgDialogId)?.unreadCount || 0) +
              (source === 'message.create' ? 1 : 0);

      const patch: Partial<DialogRow> = {
        lastMessage: {
          messageId: mid,
          content: msg.content || '',
          senderId,
          createdAt: msg.createdAt || Date.now(),
          type: msg.type
        },
        unreadCount: unread
      };

      if (ctx.dialogListFilter === 'all') {
        const bumped = bumpDialogToTop(ctx.dialogs, msgDialogId, patch);
        result.dialogs = bumped.dialogs;
        if (bumped.movedUp && msgDialogId === ctx.selectedId) {
          result.selectedMovedUp = true;
        }
        if (bumped.dialogs === ctx.dialogs && !ctx.dialogs.some((d) => d.dialogId === msgDialogId)) {
          result.needsDialogRefresh = true;
        }
      } else if (ctx.dialogListFilter === 'unanswered') {
        // You replied → leave unanswered; peer message with unread → keep/patch or refresh.
        if (senderId === ctx.myLogin || unread <= 0) {
          result.dialogs = ctx.dialogs.filter((d) => d.dialogId !== msgDialogId);
        } else if (ctx.dialogs.some((d) => d.dialogId === msgDialogId)) {
          result.dialogs = patchUnread(
            ctx.dialogs.map((d) =>
              d.dialogId === msgDialogId ? { ...d, ...patch } : d
            ),
            msgDialogId,
            unread,
            ctx.dialogListFilter
          );
        } else {
          result.needsDialogRefresh = true;
        }
      } else {
        result.dialogs = patchUnread(
          ctx.dialogs.map((d) =>
            d.dialogId === msgDialogId ? { ...d, ...patch } : d
          ),
          msgDialogId,
          unread,
          ctx.dialogListFilter
        );
      }
    }

    return result;
  }

  // --- Peer catch-up (MarkDialogAllRead finished) → ticks on open dialog ---
  // Update goes to other members only; reader gets DialogMemberUpdate via counter.
  const peerCatchUp = data?.peerCatchUp;
  if (
    peerCatchUp?.userId &&
    (source === 'dialog.messages.bulk_read' || uiTarget === 'messages.list')
  ) {
    const readerId = String(peerCatchUp.userId);
    const catchDialogId = String(peerCatchUp.dialogId || dialogId || '');
    const result: ApplyResult = {};
    if (catchDialogId && catchDialogId === ctx.selectedId && readerId && readerId !== ctx.myLogin) {
      let changed = false;
      const nextMessages = ctx.messages.map((m) => {
        if (m.senderId !== ctx.myLogin || !m.messageId) return m;
        const prev = (m.statuses || []).find((s) => s.userId === readerId)?.status;
        if (prev === 'read') return m;
        changed = true;
        return { ...m, statuses: upsertStatus(m.statuses, readerId, 'read') };
      });
      if (changed) result.messages = nextMessages;
    }
    // May also carry member unread for someone else — ignore.
    return result;
  }

  // --- Dialog member / unread (dialogs.list) ---
  if (
    source === 'dialog.member.changed' ||
    source === 'dialog.messages.bulk_read' ||
    data?.member?.state ||
    (uiTarget === 'dialogs.list' && dialogId)
  ) {
    const unread = pickUnreadCount(data?.member?.state, data?.dialog?.stats);
    if (dialogId && typeof unread === 'number') {
      return {
        dialogs: patchUnread(ctx.dialogs, dialogId, unread, ctx.dialogListFilter)
      };
    }
    // Member update without usable unread — soft refresh.
    if (source === 'dialog.member.changed' || source.startsWith('dialog.')) {
      return { needsDialogRefresh: true };
    }
  }

  // --- Fallback: structural dialog changes ---
  if (
    source === 'dialog.create' ||
    source === 'dialog.update' ||
    source === 'dialog.delete' ||
    source === 'dialog.member.add' ||
    source === 'dialog.member.remove'
  ) {
    return { needsDialogRefresh: true };
  }

  return {};
}
