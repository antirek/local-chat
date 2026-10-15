<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from './api';
import { initialsAvatar } from './avatars';

export type DirectoryUser = { login: string; name: string };

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
const loading = ref(false);
const loadError = ref('');
const query = ref('');

const excludeSet = computed(
  () => new Set((props.excludeLogins || []).map((x) => String(x).toLowerCase()))
);

const selected = computed({
  get: () => props.modelValue || [],
  set: (v: string[]) => emit('update:modelValue', v)
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return users.value.filter((u) => {
    if (excludeSet.value.has(u.login)) return false;
    if (!q) return true;
    return u.login.includes(q) || (u.name || '').toLowerCase().includes(q);
  });
});

const selectedUsers = computed(() => {
  const byLogin = new Map(users.value.map((u) => [u.login, u]));
  return selected.value
    .map((login) => byLogin.get(login) || { login, name: login })
    .filter(Boolean);
});

async function loadUsers() {
  loading.value = true;
  loadError.value = '';
  try {
    const data = await api.users();
    users.value = (data.users || []).map((u: any) => ({
      login: String(u.login || '').toLowerCase(),
      name: String(u.name || u.login || '')
    }));
  } catch (e: any) {
    loadError.value = e?.message || 'Не удалось загрузить пользователей';
    users.value = [];
  } finally {
    loading.value = false;
  }
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

watch(
  () => props.excludeLogins,
  () => {
    // Drop selections that became excluded.
    const next = selected.value.filter((l) => !excludeSet.value.has(l));
    if (next.length !== selected.value.length) selected.value = next;
  },
  { deep: true }
);

onMounted(loadUsers);

defineExpose({ reload: loadUsers, query });
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

    <p v-if="loading" class="user-picker-hint">Загрузка…</p>
    <p v-else-if="loadError" class="user-picker-error">{{ loadError }}</p>
    <p v-else-if="!filtered.length" class="user-picker-hint">Никого не найдено</p>

    <ul v-else class="user-list" role="listbox" :aria-multiselectable="mode === 'multiple'">
      <li
        v-for="u in filtered"
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
.user-picker-error {
  margin: 0;
  font-size: 13px;
  color: #64748b;
}
.user-picker-error {
  color: #b91c1c;
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
