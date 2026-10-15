/**
 * Viewport read receipts: Chotto Feed emits `messageVisible` via IntersectionObserver.
 *
 * Policy:
 * - Track the newest timestamp among messages that entered the viewport (any direction).
 * - If that covers the dialog's latest message → MarkDialogAllRead (catch-up at bottom).
 * - Else → SetMessageStatus(read) for each unprocessed incoming message at/before that cursor.
 */

import { type Ref } from 'vue';
import { api } from './api';

const FLUSH_MS = 350;

export type ViewportMessage = {
  messageId?: string;
  direction?: string;
  type?: string;
  timestamp?: number;
};

export function useViewportReadReceipts(options: {
  selectedId: Ref<string | null>;
  /** Raw Chat3 messages for the open dialog (senderId / createdAt / messageId). */
  messages: Ref<Array<{ messageId: string; senderId: string; createdAt: number; deleted?: boolean }>>;
  myLogin: Ref<string | undefined>;
  onMarked?: () => void | Promise<void>;
}) {
  const marked = new Set<string>();
  /** Highest createdAt (unix seconds or ms — same units as message.createdAt) seen in viewport. */
  let visibleUntil = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let markedDialogId: string | null = null;
  /** Avoid re-calling MarkDialogAllRead — each call emits dialog.member.changed → WS spam. */
  let dialogMarkedAllRead = false;

  function resetForDialog(dialogId: string | null) {
    if (markedDialogId === dialogId) return;
    markedDialogId = dialogId;
    marked.clear();
    visibleUntil = 0;
    dialogMarkedAllRead = false;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_MS);
  }

  function resolveCreatedAt(message: ViewportMessage): number {
    if (message.messageId) {
      const raw = options.messages.value.find((m) => m.messageId === message.messageId);
      if (raw?.createdAt) return Number(raw.createdAt) || 0;
    }
    return Number(message.timestamp) || 0;
  }

  async function flush() {
    if (flushing) {
      scheduleFlush();
      return;
    }
    const dialogId = options.selectedId.value;
    if (!dialogId || document.visibilityState === 'hidden') return;
    if (!visibleUntil) return;

    const me = options.myLogin.value;
    const all = options.messages.value.filter((m) => !m.deleted && m.messageId);
    if (!all.length) return;

    const latestAt = all.reduce((max, m) => Math.max(max, Number(m.createdAt) || 0), 0);
    const unreadIncoming = all.filter(
      (m) => m.senderId !== me && !marked.has(m.messageId) && (Number(m.createdAt) || 0) <= visibleUntil
    );

    // At bottom with nothing new to mark — do not re-hit MarkDialogAllRead.
    if (visibleUntil >= latestAt && dialogMarkedAllRead && !unreadIncoming.length) return;
    if (!unreadIncoming.length && visibleUntil < latestAt) return;
    if (!unreadIncoming.length && dialogMarkedAllRead) return;

    flushing = true;
    try {
      // Always SetMessageStatus(read) for visible incoming — that emits
      // message.status.changed so the sender's ticks update in realtime.
      // MarkDialogAllRead alone only clears unread counters (no MessageUpdate).
      const toMark =
        unreadIncoming.length > 0
          ? unreadIncoming
          : visibleUntil >= latestAt
            ? all.filter((m) => m.senderId !== me && !marked.has(m.messageId))
            : [];

      if (toMark.length) {
        await Promise.all(
          toMark.map((m) =>
            api.markMessageStatus(dialogId, m.messageId, 'read').catch((e) => {
              console.warn('markMessageStatus failed', m.messageId, e);
            })
          )
        );
        for (const m of toMark) marked.add(m.messageId);
      }

      if (visibleUntil >= latestAt) {
        if (!dialogMarkedAllRead) {
          await api.markRead(dialogId);
          dialogMarkedAllRead = true;
        }
        for (const m of all) {
          if (m.senderId !== me) marked.add(m.messageId);
        }
      } else if (!toMark.length) {
        return;
      }

      if (options.onMarked) await options.onMarked();
    } catch (e) {
      console.warn('flush read receipts failed', e);
    } finally {
      flushing = false;
    }
  }

  function onMessageVisible(message: ViewportMessage) {
    const dialogId = options.selectedId.value;
    if (!dialogId || document.visibilityState === 'hidden') return;
    if (!message?.messageId) return;
    if (message.type && String(message.type).startsWith('system')) return;

    const createdAt = resolveCreatedAt(message);
    if (createdAt > visibleUntil) visibleUntil = createdAt;
    scheduleFlush();
  }

  /** Tab focus: IntersectionObserver may not re-fire for already-visible nodes. */
  function onDocumentVisible() {
    if (document.visibilityState !== 'visible') return;
    if (!options.selectedId.value) return;
    const nodes = document.querySelectorAll<HTMLElement>('.tracking-message');
    const feed = document.querySelector('.message-feed');
    if (!feed || !nodes.length) return;
    const rootRect = feed.getBoundingClientRect();
    let advanced = false;
    for (const el of Array.from(nodes)) {
      const r = el.getBoundingClientRect();
      const visible = r.bottom > rootRect.top && r.top < rootRect.bottom;
      if (!visible) continue;
      const rawId = el.id || '';
      const id = rawId.startsWith('msg-') ? rawId.slice(4) : rawId;
      if (!id || id.startsWith('mid-')) continue;
      const raw = options.messages.value.find((m) => m.messageId === id);
      const createdAt = Number(raw?.createdAt) || 0;
      if (createdAt > visibleUntil) {
        visibleUntil = createdAt;
        advanced = true;
      }
    }
    if (advanced || visibleUntil > 0) scheduleFlush();
  }

  return {
    resetForDialog,
    onMessageVisible,
    onDocumentVisible,
    flushNow: flush
  };
}
