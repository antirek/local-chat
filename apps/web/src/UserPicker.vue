<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from './api';
import { initialsAvatar } from './avatars';

export type DirectoryUser = { login: string; name: string };

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;
const SCROLL_PREFETCH_PX = 80;

const props = withDefaults(
  defineProps<{
    /** single = DM; multiple = group members */
    mode?: 'single' | 'multiple';
    /** Exclude these logins (usually current user). */
    excludeLogins?: string[];
    modelValue?: string[];
    placeholder?: string;
  }>(),
  {
    mode: 'single',
    excludeLogins: () => [],
    modelValue: () => [],
    placeholder: 'Поиск по имени или логину'
  }
);

const emit = defineEmits<{
  'update:modelValue': [value: string[]];
}>();

const users = ref<DirectoryUser[]>([]);
/** Keep names for selected chips even if they left the current result page. */
const knownByLogin = ref<Record<string, DirectoryUser>>({});
const loading = ref(false);
const loadingMore = ref(false);
const loadError = ref('');
const query = ref('');
const page = ref(0);
const pages = ref(1);
const listEl = ref<HTMLElement | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let fetchSeq = 0;

const excludeSet = computed(
  () => new Set((props.excludeLogins || []).map((x) => String(x).toLowerCase()))
);

const selected = computed({
  get: () => props.modelValue || [],
  set: (v: string[]) => emit('update:modelValue', v)
});

const hasMore = computed(() => page.value < pages.value);

const selectedUsers = computed(() =>
  selected.value.map((login) => knownByLogin.value[login] || { login, name: login })
);

function mapUsers(raw: any[]): DirectoryUser[] {
  return (raw || []).map((u: any) => ({
    login: String(u.login || '').toLowerCase(),
    name: String(u.name || u.login || '')
  }));
}

function remember(list: DirectoryUser[]) {
  if (!list.length) return;
  const next = { ...knownByLogin.value };
  for (const u of list) next[u.login] = u;
  knownByLogin.value = next;
}

async function fillViewportIfNeeded(seq: number) {
  await nextTick();
  const el = listEl.value;
  if (!el || seq !== fetchSeq) return;
  // Short result set may not create a scrollbar — keep fetching until it does or done.
  if (hasMore.value && !loading.value && !loadingMore.value && el.scrollHeight <= el.clientHeight + 4) {
    await loadMore();
  }
}

async function fetchPage(nextPage: number, opts: { replace: boolean; q: string }) {
  const seq = ++fetchSeq;
  if (opts.replace) {
    loading.value = true;
    loadError.value = '';
  } else {
    loadingMore.value = true;
  }
  try {
    const data = await api.users({ page: nextPage, limit: PAGE_SIZE, q: opts.q || null });
    if (seq !== fetchSeq) return;

    const mapped = mapUsers(data.users).filter((u) => !excludeSet.value.has(u.login));
    remember(mapped);
    users.value = opts.replace ? mapped : [...users.value, ...mapped];

    const p = data.pagination || {};
    page.value = Number(p.page) || nextPage;
    pages.value = Math.max(1, Number(p.pages) || 1);
  } catch (e: any) {
    if (seq !== fetchSeq) return;
    loadError.value = e?.message || 'Не удалось загрузить пользователей';
    if (opts.replace) {
      users.value = [];
      page.value = 0;
      pages.value = 1;
    }
  } finally {
    if (seq === fetchSeq) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
  if (seq === fetchSeq) await fillViewportIfNeeded(seq);
}

function reload(q = query.value.trim()) {
  page.value = 0;
  pages.value = 1;
  users.value = [];
  return fetchPage(1, { replace: true, q });
}

function loadMore() {
  if (loading.value || loadingMore.value || !hasMore.value) return;
  return fetchPage(page.value + 1, { replace: false, q: query.value.trim() });
}

function onListScroll() {
  const el = listEl.value;
  if (!el || loading.value || loadingMore.value || !hasMore.value) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_PREFETCH_PX) {
    void loadMore();
  }
}

function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void reload(query.value.trim());
  }, SEARCH_DEBOUNCE_MS);
}

function isSelected(login: string) {
  return selected.value.includes(login);
}

function toggle(login: string) {
  if (props.mode === 'single') {
    selected.value = [login];
    return;
  }
  if (isSelected(login)) {
    selected.value = selected.value.filter((x) => x !== login);
  } else {
    selected.value = [...selected.value, login];
  }
}

function removeChip(login: string) {
  selected.value = selected.value.filter((x) => x !== login);
}

watch(query, () => scheduleSearch());

watch(
  () => props.excludeLogins,
  () => {
    const next = selected.value.filter((l) => !excludeSet.value.has(l));
    if (next.length !== selected.value.length) selected.value = next;
    users.value = users.value.filter((u) => !excludeSet.value.has(u.login));
  },
  { deep: true }
);

watch(selected, (logins) => {
  // Ensure chips have labels for selections made before known map was filled.
  for (const login of logins) {
    if (!knownByLogin.value[login]) {
      const fromList = users.value.find((u) => u.login === login);
      if (fromList) remember([fromList]);
    }
  }
});

onMounted(async () => {
  await reload('');
  await nextTick();
  listEl.value?.addEventListener('scroll', onListScroll, { passive: true });
});

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  listEl.value?.removeEventListener('scroll', onListScroll);
});

defineExpose({ reload, query });
</script>

<template>
  <div class="user-picker" data-testid="user-picker">
    <div v-if="mode === 'multiple' && selectedUsers.length" class="user-picker-chips">
      <button
        v-for="u in selectedUsers"
        :key="u.login"
        type="button"
        class="user-chip"
        :title="`Убрать @${u.login}`"
        @click="removeChip(u.login)"
      >
        <img :src="initialsAvatar(u.login, u.name)" alt="" width="20" height="20" />
        <span>{{ u.name || u.login }}</span>
        <span class="user-chip-x" aria-hidden="true">×</span>
      </button>
    </div>

    <input
      v-model="query"
      class="user-search"
      type="search"
      data-testid="user-search"
      :placeholder="placeholder"
      autocomplete="off"
    />

    <p v-if="loading && !users.length" class="user-picker-hint">Загрузка…</p>
    <p v-else-if="loadError && !users.length" class="user-picker-error">{{ loadError }}</p>
    <p v-else-if="!loading && !users.length" class="user-picker-hint">Никого не найдено</p>

    <ul
      v-show="users.length"
      ref="listEl"
      class="user-list"
      role="listbox"
      :aria-multiselectable="mode === 'multiple'"
      data-testid="user-list"
    >
      <li
        v-for="u in users"
        :key="u.login"
        role="option"
        class="user-option"
        :class="{ selected: isSelected(u.login) }"
        :aria-selected="isSelected(u.login)"
        :data-testid="'user-option'"
        :data-login="u.login"
        @click="toggle(u.login)"
      >
        <img :src="initialsAvatar(u.login, u.name)" alt="" width="36" height="36" />
        <div class="user-option-text">
          <strong>{{ u.name || u.login }}</strong>
          <span>@{{ u.login }}</span>
        </div>
        <span class="user-check" aria-hidden="true">{{ isSelected(u.login) ? '✓' : '' }}</span>
      </li>
      <li v-if="loadingMore" class="user-picker-more">Загрузка…</li>
      <li v-else-if="hasMore" class="user-picker-more muted">Прокрутите ниже</li>
    </ul>
  </div>
</template>

<style scoped>
.user-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}
.user-search {
  width: 100%;
  margin: 0 !important;
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
}
.user-picker-hint,
.user-picker-error,
.user-picker-more {
  margin: 0;
  font-size: 13px;
  color: #64748b;
}
.user-picker-error {
  color: #b91c1c;
}
.user-picker-more {
  list-style: none;
  padding: 10px;
  text-align: center;
}
.user-picker-more.muted {
  opacity: 0.7;
}
.user-picker-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.user-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: #e2e8f0;
  color: #0f172a;
  border-radius: 999px;
  padding: 4px 8px 4px 4px;
  font-size: 12px;
  cursor: pointer;
}
.user-chip img {
  border-radius: 50%;
}
.user-chip-x {
  font-size: 14px;
  line-height: 1;
  opacity: 0.7;
}
.user-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}
.user-option {
  display: grid;
  grid-template-columns: 36px 1fr 20px;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  cursor: pointer;
  border-bottom: 1px solid #f1f5f9;
}
.user-option:last-child {
  border-bottom: 0;
}
.user-option:hover {
  background: #f8fafc;
}
.user-option.selected {
  background: #ecfdf5;
}
.user-option img {
  border-radius: 50%;
}
.user-option-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.user-option-text strong {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-option-text span {
  font-size: 12px;
  color: #64748b;
}
.user-check {
  color: #0f766e;
  font-weight: 700;
  text-align: center;
}
</style>
