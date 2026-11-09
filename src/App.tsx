// Каркас приложения: навигация по вкладкам (боковая на ПК, нижняя на телефоне), шапка с синхронизацией
// и быстрым вводом, карточка записи и окно «Где деньги».
import { useCallback, useMemo, useState } from 'react';
import type { Entry } from './model/types';
import { newEntry } from './model/entry';
import { UiContext, useIsMobile, type UiApi } from './ui/common';
import { SyncIndicator } from './ui/SyncIndicator';
import { QuickAdd } from './ui/QuickAdd';
import { EntryCard } from './ui/EntryCard';
import { MoneyDialog } from './ui/MoneyEditor';
import { TableView } from './ui/TableView';
import { TasksView } from './ui/TasksView';
import { CalendarView } from './ui/CalendarView';
import { MoneyView } from './ui/MoneyView';
import { SummaryView } from './ui/SummaryView';
import { SettingsView } from './ui/SettingsView';
import { lsGet, lsSet } from './ui/util';
import './ui/styles.css';

export type Tab = 'table' | 'tasks' | 'calendar' | 'money' | 'summary' | 'settings';

export const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'table', label: 'Таблица', icon: '▦' },
  { id: 'tasks', label: 'Задачи', icon: '☑' },
  { id: 'calendar', label: 'Календарь', icon: '📅' },
  { id: 'money', label: 'Деньги', icon: '€' },
  { id: 'summary', label: 'Итоги', icon: '📊' },
  { id: 'settings', label: 'Настройки', icon: '⚙' },
];

type CardState = { id: string } | { draft: Entry } | null;

export function App({ storageError }: { storageError?: string }) {
  const mobile = useIsMobile();
  const [tab, setTabState] = useState<Tab>(() => {
    const saved = lsGet<Tab | null>('wlt.tab', null);
    if (saved && TABS.some((t) => t.id === saved)) return saved;
    return mobile ? 'tasks' : 'table';
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    lsSet('wlt.tab', t);
  };
  const [card, setCard] = useState<CardState>(null);
  const [moneyId, setMoneyId] = useState<string | null>(null);
  const [bannerHidden, setBannerHidden] = useState(false);

  const closeCard = useCallback(() => setCard(null), []);
  const closeMoney = useCallback(() => setMoneyId(null), []);
  const ui = useMemo<UiApi>(
    () => ({
      openEntry: (id) => setCard({ id }),
      createEntry: (partial) => setCard({ draft: newEntry(partial) }),
      openMoney: (id) => setMoneyId(id),
    }),
    [],
  );

  const current = TABS.find((t) => t.id === tab)!;

  return (
    <UiContext.Provider value={ui}>
      <div className={'app' + (mobile ? ' is-mobile' : ' is-desktop')}>
        {!mobile && (
          <nav className="sidenav" aria-label="Разделы">
            <div className="brand">Трекер съёмок</div>
            {TABS.map((t) => (
              <button
                type="button"
                key={t.id}
                className={'nav-btn' + (t.id === tab ? ' on' : '')}
                aria-current={t.id === tab ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                <span className="nav-icon" aria-hidden>
                  {t.icon}
                </span>
                {t.label}
              </button>
            ))}
          </nav>
        )}
        <div className="main">
          <header className="topbar">
            {mobile && <h1 className="page-title">{current.label}</h1>}
            <div className="topbar-quick">
              <QuickAdd />
            </div>
            <div className="topbar-right">
              <SyncIndicator compact={mobile} />
              <button type="button" className="primary new-btn" onClick={() => ui.createEntry()} aria-label="Новая запись">
                {mobile ? '+' : '+ Запись'}
              </button>
            </div>
          </header>
          {storageError && !bannerHidden && (
            <div className="banner warn" role="alert">
              <span>
                Хранилище браузера недоступно ({storageError}). Приложение работает, но данные живут только в памяти этой
                вкладки: после закрытия они пропадут, если не включена синхронизация с Google Drive. Частый случай —
                приватный режим браузера.
              </span>
              <button type="button" className="icon-btn" aria-label="Скрыть" onClick={() => setBannerHidden(true)}>
                ✕
              </button>
            </div>
          )}
          <main className="content" aria-label={current.label}>
            {tab === 'table' && <TableView />}
            {tab === 'tasks' && <TasksView />}
            {tab === 'calendar' && <CalendarView />}
            {tab === 'money' && <MoneyView />}
            {tab === 'summary' && <SummaryView />}
            {tab === 'settings' && <SettingsView />}
          </main>
        </div>
        {mobile && (
          <nav className="tabbar" aria-label="Разделы">
            {TABS.map((t) => (
              <button
                type="button"
                key={t.id}
                className={'tab-btn' + (t.id === tab ? ' on' : '')}
                aria-current={t.id === tab ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                <span className="tab-icon" aria-hidden>
                  {t.icon}
                </span>
                <span className="tab-label">{t.label}</span>
              </button>
            ))}
          </nav>
        )}
        {card && 'id' in card && <EntryCard key={card.id} id={card.id} onClose={closeCard} />}
        {card && 'draft' in card && <EntryCard key={card.draft.id} draft={card.draft} onClose={closeCard} />}
        {moneyId && <MoneyDialog id={moneyId} onClose={closeMoney} />}
      </div>
    </UiContext.Provider>
  );
}

export default App;
