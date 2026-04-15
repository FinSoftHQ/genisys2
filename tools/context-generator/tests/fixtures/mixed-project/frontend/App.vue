<template>
  <div id="app" class="app-container">
    <header class="app-header">
      <h1>{{ title }}</h1>
      <nav>
        <router-link to="/">Home</router-link>
        <router-link to="/about">About</router-link>
      </nav>
    </header>
    
    <main class="app-main">
      <router-view />
    </main>
    
    <footer class="app-footer">
      <p>&copy; {{ currentYear }} {{ appName }}</p>
    </footer>
  </div>
</template>

<script setup lang="ts">
/**
 * Main App Component
 * 
 * Root component for the Vue application.
 * Provides layout structure and global state.
 */
import { ref, computed, onMounted, provide } from 'vue';
import { useStore } from '@/store';
import type { User, AppConfig } from '@/types';

/**
 * Props definition
 */
interface Props {
  /** Initial page title */
  initialTitle?: string;
}

const props = withDefaults(defineProps<Props>(), {
  initialTitle: 'My App',
});

/**
 * Emitted events
 */
interface Emits {
  /** Emitted when app is ready */
  (e: 'ready', timestamp: number): void;
  /** Emitted on error */
  (e: 'error', error: Error): void;
}

const emit = defineEmits<Emits>();

// Store and state
const store = useStore();
const currentUser = ref<User | null>(null);
const isLoading = ref(false);

// Computed properties
const title = computed(() => props.initialTitle);
const appName = computed(() => store.state.appName);
const currentYear = computed(() => new Date().getFullYear());

// Methods
/**
 * Initialize the application
 */
async function initializeApp(): Promise<void> {
  isLoading.value = true;
  try {
    await store.dispatch('initialize');
    currentUser.value = store.state.user;
    emit('ready', Date.now());
  } catch (error) {
    emit('error', error as Error);
  } finally {
    isLoading.value = false;
  }
}

/**
 * Handle user logout
 */
async function handleLogout(): Promise<void> {
  await store.dispatch('logout');
  currentUser.value = null;
}

// Provide global state
provide('appConfig', {
  version: '1.0.0',
  debug: process.env.NODE_ENV === 'development',
} as AppConfig);

// Lifecycle
onMounted(() => {
  initializeApp();
});
</script>

<style scoped>
.app-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-header {
  padding: 1rem;
  background: #333;
  color: white;
}

.app-main {
  flex: 1;
  padding: 2rem;
}

.app-footer {
  padding: 1rem;
  background: #f5f5f5;
  text-align: center;
}
</style>
