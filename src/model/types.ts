// Общая модель данных трекера. Контракт для всех модулей (store, ods, export, sync, calendar, ui).
// Менять только через оркестратора — от этих типов зависят все модули.
// Описание полей — SPEC.md §5.

export type ISODate = string;      // 'YYYY-MM-DD'
export type ISODateTime = string;  // new Date().toISOString()
export type YearMonth = string;    // 'YYYY-MM'

/** Встроенные типы задач: есть всегда, на них опираются импорт и парсер. */
export type BuiltinType = 'main' | 'joint' | 'personal';

/**
 * Тип задачи — id из Settings.taskTypes (встроенный 'main' | 'joint' | 'personal' или свой).
 * Задаёт цвет записи везде.
 */
export type EntryType = string;

/** Определение типа задачи (настраивается в «Настройках»). */
export interface TaskTypeDef {
  id: string;
  name: string;
  color: string;
  /** Тип с деньгами: показывает поля денег и входит в оборот. */
  money: boolean;
  /** Встроенный тип (main/joint/personal): удалить нельзя, флаг money не меняется. */
  builtin?: boolean;
  /** Tombstone: тип удалён (чтобы синхронизация не вернула его). */
  deleted?: boolean;
}

/** Вид записи. */
export type EntryKind = 'shoot' | 'work' | 'payment' | 'event' | 'note';

export type EntryStatus = 'lead' | 'booked' | 'shot' | 'editing' | 'delivered' | 'done' | 'cancelled';

export type Media = 'photo' | 'video';

/** Где лежат деньги. */
export type MoneyWhere = 'client' | 'intermediary' | 'owner';

export type PayMethod = 'cash' | 'revolut' | 'bank' | string;

export interface MoneyPart {
  amount: number;
  where: MoneyWhere;
  /** Посредник (Source.id), если where = 'intermediary'. */
  holderId?: string;
  method?: PayMethod;
  at?: ISODateTime;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface EntryOrigin {
  sheet: string;
  row: number;
  raw: string;
}

/** Запись журнала: перемещение денег, смена статуса и т.п. */
export interface HistoryItem {
  at: ISODateTime;
  text: string;
}

export interface Entry {
  id: string;
  type: EntryType;
  kind: EntryKind;
  title: string;
  date?: ISODate;
  dateEnd?: ISODate;
  dateTentative: boolean;
  timeStart?: string; // 'HH:mm'
  timeEnd?: string;   // 'HH:mm'
  timeNote?: string;
  allDay: boolean;
  location?: string;
  mapUrl?: string;
  category?: string;
  media: Media[];
  withEditing?: boolean;
  amount?: number;
  currency: 'EUR';
  /** Сумма частей = amount (если amount задан). */
  money: MoneyPart[];
  /** Только справка; инвойсы ведутся в отдельном приложении. */
  invoiceNo?: string;
  /** В какой месяц засчитать: записи без даты, предоплаты, «оплачено в феврале». */
  accountingMonth?: YearMonth;
  relatedEntryId?: string;
  contactId?: string;
  sourceId?: string;
  status: EntryStatus;
  checklist: ChecklistItem[];
  notes?: string;
  history?: HistoryItem[];
  calendarEventId?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /** Время правки каждого поля — для слияния по полям при синхронизации (SPEC §7). */
  fieldUpdatedAt?: Partial<Record<keyof Entry, ISODateTime>>;
  /** Tombstone. */
  deleted?: boolean;
  origin?: EntryOrigin;
}

export type ChannelKind = 'whatsapp' | 'telegram' | 'instagram' | 'facebook' | 'sms' | 'email' | 'phone';

export interface Contact {
  id: string;
  name: string;
  phones: string[];
  channels: { kind: ChannelKind; value: string }[];
  notes?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deleted?: boolean;
}

/** Источник заказа / посредник: человек, «ребята», агентство. */
export interface Source {
  id: string;
  name: string;
  /** Варианты написания для парсера: «петя», «пети», «петей». */
  aliases: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deleted?: boolean;
}

/** @deprecated Заменено Settings.taskTypes; читается только при миграции старых документов. */
export interface TypeColors {
  main: string;
  joint: string;
  personal: string;
}

export interface Settings {
  /** Грубая оценка чистого дохода после налогов: оборот × netFactor. */
  netFactor: number;
  categories: string[];
  /** Типы задач (встроенные + свои). Читать через taskTypes()/typeDef() из model/taskTypes. */
  taskTypes: TaskTypeDef[];
  /** @deprecated Старое поле цветов трёх типов; не используется, читается только при миграции. */
  typeColors?: TypeColors;
  /** Код страны для номеров без кода (например '44') — для ссылок WhatsApp/Telegram. */
  phoneCountryCode?: string;
  /** Порог «деньги у посредника слишком долго», дней. */
  intermediaryOverdueDays: number;
  calendar: {
    enabled: boolean;
    calendarId?: string;
    calendarName: string;
    includeMoney: boolean;
    personalMode: 'full' | 'busy' | 'skip';
    reminderMinutes: number[];
    /** @deprecated syncToken локален для устройства, хранится в store meta 'calendarState'. */
    syncToken?: string;
    onCancel: 'delete' | 'mark';
  };
  updatedAt: ISODateTime;
}

/** Канонический документ — то, что лежит в Drive пользователя: «Трекер/tracker.json» (пишет Apps Script). */
export interface TrackerDoc {
  schemaVersion: 1;
  entries: Entry[];
  contacts: Contact[];
  sources: Source[];
  settings: Settings;
}

export const DEFAULT_CATEGORIES = [
  'день рождения',
  'детский день рождения',
  'свадьба',
  'крестины',
  'корпоратив',
  'семейная',
  'портреты',
  'интерьер',
  'контент',
  'школа',
  'прессволл',
  'спектакль',
  'репортаж',
  'ретушь',
];

export const DEFAULT_SETTINGS: Settings = {
  netFactor: 0.67,
  categories: DEFAULT_CATEGORIES,
  taskTypes: [
    { id: 'main', name: 'Основная работа', color: '#a5d6a7', money: true, builtin: true },
    { id: 'joint', name: 'Совместная работа', color: '#80deea', money: true, builtin: true },
    { id: 'personal', name: 'Личное', color: '#fff59d', money: false, builtin: true },
  ],
  intermediaryOverdueDays: 14,
  calendar: {
    enabled: false,
    calendarName: 'Съёмки',
    includeMoney: false,
    personalMode: 'full',
    reminderMinutes: [24 * 60, 120],
    onCancel: 'delete',
  },
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export const STATUS_LABELS: Record<EntryStatus, string> = {
  lead: 'Заявка',
  booked: 'Забронировано',
  shot: 'Отснято',
  editing: 'В обработке',
  delivered: 'Отдано',
  done: 'Закрыто',
  cancelled: 'Отменено',
};

/** Названия встроенных типов по умолчанию (текущие названия — typeName() из model/taskTypes). */
export const TYPE_LABELS: Record<BuiltinType, string> = {
  main: 'Основная работа',
  joint: 'Совместная работа',
  personal: 'Личное',
};

export const KIND_LABELS: Record<EntryKind, string> = {
  shoot: 'Съёмка',
  work: 'Обработка',
  payment: 'Оплата',
  event: 'Дело',
  note: 'Заметка',
};

export const WHERE_LABELS: Record<MoneyWhere, string> = {
  client: 'У клиента',
  intermediary: 'У посредника',
  owner: 'Получено',
};
