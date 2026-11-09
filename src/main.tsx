// Точка входа: загрузка локальных данных, запуск синхронизации, регистрация service worker, рендер.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { store } from './store/store';
import { syncEngine } from './sync/syncEngine';
import { calendarAfterSync } from './calendar/calendarSync';
import { App } from './App';

async function boot() {
  let storageError: string | undefined;
  try {
    await store.load();
  } catch (e) {
    // Приватный режим / запрет IndexedDB: работаем в памяти и показываем предупреждение.
    storageError = e instanceof Error ? e.message || e.name : String(e);
    console.warn('IndexedDB недоступна, данные только в памяти', e);
  }

  try {
    syncEngine.addAfterSyncHook(calendarAfterSync);
    syncEngine.start();
  } catch (e) {
    console.warn('Синхронизация не запустилась', e);
  }

  try {
    registerSW({ immediate: true });
  } catch (e) {
    console.warn('Service worker не зарегистрирован', e);
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App storageError={storageError} />
    </StrictMode>,
  );
}

void boot();
