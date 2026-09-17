<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import {
  BaseContainer,
  BaseLayout,
  ChatWrapper,
  ChatList,
  ChatListHeader,
  ChatInfo,
  Feed,
  ChatInput,
  ButtonEmojiPicker,
  insertDaySeparators,
  sortByTimestamp,
  formatTimestamp
} from '@mobilon-dev/chotto';
import {
  api,
  clearSession,
  connectUpdates,
  getToken,
  getUser,
  setSession,
  type User
} from './api';
import { formatClock, initialsAvatar, toUnixSeconds } from './avatars';

const user = ref<User | null>(getUser());
const token = ref<string | null>(getToken());
const mode = ref<'login' | 'register'>('login');
const login = ref('');
const name = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

const dialogs = ref<any[]>([]);
const selectedId = ref<string | null>(null);
const messages = ref<any[]>([]);
const showDm = ref(false);
const showGroup = ref(false);
const peerLogin = ref('');
const groupTitle = ref('');
const groupMembers = ref('');
const scrollFeedToBottom = ref(false);

let ws: WebSocket | null = null;

const chatListItems = computed(() => {
  const items = dialogs.value.map((d) => {
    const meta = d.meta || {};
    const isDm = meta.type === 'dm';
    const title = isDm
      ? (meta.dmKey || '')
          .split(':')
          .filter((x: string) => x && x !== user.value?.login)
          .join('') || 'DM'
      : meta.title || 'Группа';
    const ts = toUnixSeconds(d.lastMessage?.createdAt || d.createdAt || Date.now());
    return {
      chatId: d.dialogId,
      name: title,
      avatar: initialsAvatar(String(d.dialogId || title), title),
      countUnread: d.unreadCount || 0,
      lastMessage: d.lastMessage?.content || '',
      'lastActivity.timestamp': ts,
      'lastActivity.time': formatClock(ts),
      status: '#10b981',
      isSelected: d.dialogId === selectedId.value
    };
  });
  return items.sort(
    (a, b) => Number(b['lastActivity.timestamp']) - Number(a['lastActivity.timestamp'])
  );
});

const selectedChat = computed(
  () => chatListItems.value.find((c) => c.chatId === selectedId.value) || null
);
provide('selectedChat', selectedChat);

const feedObjects = computed(() => {
  const mapped = messages.value
    .filter((m) => !m.deleted)
    .map((m) => {
      const timestamp = toUnixSeconds(m.createdAt);
      const incoming = m.senderId !== user.value?.login;
      const senderLabel = m.senderName || m.senderId;
      return {
        type: 'message.text',
        messageId: m.messageId,
        text: m.content,
        timestamp,
        status: 'read',
        direction: incoming ? 'incoming' : 'outgoing',
        // header/avatar only for incoming — closer to Slack / BasicChat polish
        header: incoming ? senderLabel : undefined,
        avatar: incoming
          ? initialsAvatar(String(m.senderId || senderLabel), senderLabel)
          : undefined
      };
    });
  const sorted = sortByTimestamp(mapped as any);
  const withPosition = sorted.map((m: any) => ({
    ...m,
    position: m.direction === 'outgoing' ? 'right' : 'left',
    time: formatTimestamp(String(m.timestamp))
  }));
  return insertDaySeparators(withPosition as any);
});

async function submitAuth() {
  error.value = '';
  loading.value = true;
  try {
    const data =
      mode.value === 'login'
        ? await api.login({ login: login.value, password: password.value })
        : await api.register({
            login: login.value,
            name: name.value,
            password: password.value
          });
    setSession(data.token, data.user);
    token.value = data.token;
    user.value = data.user;
    await bootChat();
  } catch (e: any) {
    error.value = e.message || 'Ошибка';
  } finally {
    loading.value = false;
  }
}

function logout() {
  clearSession();
  token.value = null;
  user.value = null;
  dialogs.value = [];
  messages.value = [];
  selectedId.value = null;
  ws?.close();
  ws = null;
}

async function refreshDialogs() {
  const data = await api.dialogs();
  dialogs.value = data.dialogs || [];
}

async function openDialog(dialogId: string) {
  if (!dialogId || dialogId === 'undefined' || dialogId === 'null') {
    console.warn('openDialog: skip invalid dialogId', dialogId);
    return;
  }
  selectedId.value = dialogId;
  const data = await api.messages(dialogId);
  messages.value = data.messages || [];
  bumpScroll();
  try {
    await api.markRead(dialogId);
    await refreshDialogs();
  } catch (e) {
    console.warn('markRead failed', e);
  }
}

let typingTimer: ReturnType<typeof setTimeout> | null = null;
async function onTyping() {
  if (!selectedId.value) return;
  if (typingTimer) return;
  typingTimer = setTimeout(() => {
    typingTimer = null;
  }, 2500);
  try {
    await api.typing(selectedId.value);
  } catch {
    /* ignore */
  }
}

function bumpScroll() {
  scrollFeedToBottom.value = false;
  requestAnimationFrame(() => {
    scrollFeedToBottom.value = true;
  });
}

async function onSelectChat(payload: any) {
  const chat = payload?.chat ?? payload;
  const dialogId = chat?.chatId ?? payload?.dialog?.dialogId;
  if (!dialogId) {
    console.warn('onSelectChat: no chatId in payload', payload);
    return;
  }
  await openDialog(String(dialogId));
}

async function onSend(payload: any) {
  if (!selectedId.value) return;
  const text = payload?.text || '';
  if (!String(text).trim()) return;
  const data = await api.send(selectedId.value, String(text));
  messages.value = [...messages.value, { ...data.message, senderName: user.value?.name }];
  bumpScroll();
  await refreshDialogs();
}

async function createDm() {
  error.value = '';
  try {
    const data = await api.dm(peerLogin.value.trim().toLowerCase());
    showDm.value = false;
    peerLogin.value = '';
    await refreshDialogs();
    await openDialog(data.dialog.dialogId);
  } catch (e: any) {
    error.value = e.message;
  }
}

async function createGroup() {
  error.value = '';
  try {
    const members = groupMembers.value
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    const data = await api.group(groupTitle.value.trim(), members);
    showGroup.value = false;
    groupTitle.value = '';
    groupMembers.value = '';
    await refreshDialogs();
    await openDialog(data.dialog.dialogId);
  } catch (e: any) {
    error.value = e.message;
  }
}

async function bootChat() {
  await refreshDialogs();
  ws?.close();
  ws = connectUpdates(async (payload) => {
    if (payload.type !== 'chat3.update') return;
    await refreshDialogs();
    if (selectedId.value && selectedId.value !== 'undefined') {
      try {
        const data = await api.messages(selectedId.value);
        messages.value = data.messages || [];
        bumpScroll();
      } catch (e) {
        console.warn('refresh messages failed', e);
      }
    }
  });
}

onMounted(async () => {
  if (token.value && user.value) {
    try {
      await bootChat();
    } catch {
      logout();
    }
  }
});

onUnmounted(() => ws?.close());

const groupPanel = ref(false);
const groupMemberList = ref<{ login: string; name: string }[]>([]);
const renameTitle = ref('');
const addMemberLogin = ref('');

async function loadGroupPanel() {
  if (!selectedId.value) return;
  const d = dialogs.value.find((x) => x.dialogId === selectedId.value);
  if (!d || d.meta?.type !== 'group') {
    groupPanel.value = false;
    return;
  }
  renameTitle.value = String(d.meta?.title || '');
  try {
    const data = await api.members(selectedId.value);
    groupMemberList.value = data.members || [];
  } catch (e: any) {
    console.warn('members', e);
  }
}

async function renameGroup() {
  if (!selectedId.value || !renameTitle.value.trim()) return;
  try {
    await api.renameDialog(selectedId.value, renameTitle.value.trim());
    await refreshDialogs();
    await loadGroupPanel();
  } catch (e: any) {
    error.value = e.message;
  }
}

async function addGroupMember() {
  if (!selectedId.value || !addMemberLogin.value.trim()) return;
  try {
    await api.addMembers(selectedId.value, [addMemberLogin.value.trim().toLowerCase()]);
    addMemberLogin.value = '';
    await refreshDialogs();
    await loadGroupPanel();
  } catch (e: any) {
    error.value = e.message;
  }
}

async function removeGroupMember(login: string) {
  if (!selectedId.value) return;
  try {
    await api.removeMember(selectedId.value, login);
    await refreshDialogs();
    await loadGroupPanel();
  } catch (e: any) {
    error.value = e.message;
  }
}

watch(selectedId, () => {
  error.value = '';
  groupPanel.value = false;
  void loadGroupPanel();
});
</script>

<template>
  <div v-if="!token || !user" class="auth-page">
    <form class="auth-card" @submit.prevent="submitAuth">
      <h1>Local Chat</h1>
      <p>Корпоративный чат на Chat3 gRPC + Chotto</p>
      <p v-if="error" class="error">{{ error }}</p>
      <label>Логин</label>
      <input v-model="login" autocomplete="username" required />
      <template v-if="mode === 'register'">
        <label>Имя</label>
        <input v-model="name" required />
      </template>
      <label>Пароль</label>
      <input v-model="password" type="password" autocomplete="current-password" required />
      <button type="submit" :disabled="loading">
        {{ mode === 'login' ? 'Войти' : 'Зарегистрироваться' }}
      </button>
      <button class="secondary" type="button" @click="mode = mode === 'login' ? 'register' : 'login'">
        {{ mode === 'login' ? 'Создать аккаунт' : 'У меня есть аккаунт' }}
      </button>
    </form>
  </div>

  <div v-else class="chat-shell" data-theme="light">
    <div class="toolbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true" />
        <strong>Local Chat</strong>
      </div>
      <div class="spacer" />
      <span class="user">{{ user.name }} (@{{ user.login }})</span>
      <button class="ghost" type="button" @click="logout">Выйти</button>
    </div>
    <p v-if="error" class="error" style="padding: 8px 14px; margin: 0">{{ error }}</p>

    <div class="chat-main">
      <BaseContainer height="100%" width="100%">
        <BaseLayout style="height: 100%; min-height: 0;">
          <template #first-col>
            <ChatList filter-enabled :chats="chatListItems" @select="onSelectChat">
              <template #header>
                <ChatListHeader title="Диалоги" :beta-enabled="false">
                  <template #actions>
                    <div class="header-actions">
                      <button class="header-action" type="button" @click="showDm = true">DM</button>
                      <button class="header-action secondary" type="button" @click="showGroup = true">
                        Группа
                      </button>
                    </div>
                  </template>
                </ChatListHeader>
              </template>
            </ChatList>
          </template>
          <template #second-col>
            <div style="height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;">
              <ChatWrapper
                :is-selected-chat="!!selectedChat"
                style="height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;"
              >
                <template #placeholder>
                  <div class="empty-chat">
                    <div>
                      <strong>Выберите диалог</strong>
                      Создайте DM или группу слева, чтобы начать переписку
                    </div>
                  </div>
                </template>
                <ChatInfo v-if="selectedChat" :chat="selectedChat" description="в сети" />
                <div
                  v-if="selectedChat && dialogs.find((d) => d.dialogId === selectedId)?.meta?.type === 'group'"
                  class="group-bar"
                >
                  <button class="ghost" type="button" @click="groupPanel = !groupPanel">
                    {{ groupPanel ? 'Скрыть участников' : 'Участники / название' }}
                  </button>
                  <div v-if="groupPanel" class="group-panel">
                    <div class="group-row">
                      <input v-model="renameTitle" placeholder="название группы" />
                      <button type="button" @click="renameGroup">Сохранить</button>
                    </div>
                    <ul class="member-list">
                      <li v-for="m in groupMemberList" :key="m.login">
                        <span>{{ m.name }} (@{{ m.login }})</span>
                        <button
                          v-if="m.login !== user.login"
                          class="ghost"
                          type="button"
                          @click="removeGroupMember(m.login)"
                        >
                          Убрать
                        </button>
                      </li>
                    </ul>
                    <div class="group-row">
                      <input v-model="addMemberLogin" placeholder="логин участника" />
                      <button type="button" @click="addGroupMember">Добавить</button>
                    </div>
                  </div>
                </div>
                <div class="feed-area">
                  <Feed
                    v-if="selectedChat"
                    :key="selectedChat.chatId"
                    class="lc-feed"
                    :objects="feedObjects"
                    :current-user-id="user.login"
                    :scroll-to-bottom="scrollFeedToBottom"
                    :reactions-enabled="false"
                  />
                </div>
                <ChatInput v-if="selectedChat" @send="onSend" @typing="onTyping">
                  <template #inline-buttons>
                    <ButtonEmojiPicker mode="click" state="active" :native="true" />
                  </template>
                </ChatInput>
              </ChatWrapper>
            </div>
          </template>
        </BaseLayout>
      </BaseContainer>
    </div>

    <div v-if="showDm" class="modal-backdrop" @click.self="showDm = false">
      <div class="modal">
        <h3>Прямое сообщение</h3>
        <input v-model="peerLogin" placeholder="логин собеседника" />
        <div class="actions">
          <button class="ghost" type="button" @click="showDm = false">Отмена</button>
          <button type="button" @click="createDm">Открыть</button>
        </div>
      </div>
    </div>

    <div v-if="showGroup" class="modal-backdrop" @click.self="showGroup = false">
      <div class="modal">
        <h3>Группа</h3>
        <input v-model="groupTitle" placeholder="название" />
        <input v-model="groupMembers" placeholder="логины через запятую" />
        <div class="actions">
          <button class="ghost" type="button" @click="showGroup = false">Отмена</button>
          <button type="button" @click="createGroup">Создать</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.group-bar {
  padding: 6px 14px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.group-panel {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.group-row {
  display: flex;
  gap: 8px;
}
.group-row input {
  flex: 1;
}
.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 120px;
  overflow: auto;
}
.member-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
  font-size: 13px;
}
.lc-feed {
  height: 100%;
  --chotto-feed-padding: 16px 20px 20px;
  --chotto-textmessage-content-max-width: 640px;
  --chotto-feed-scroll-behavior: auto;
  --chotto-textmessage-right-grid-template-columns: 1fr;
  --chotto-textmessage-right-content-grid-column: 1;
  --chotto-textmessage-left-box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  --chotto-textmessage-right-box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}
</style>
