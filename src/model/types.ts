// Общая модель данных трекера. Контракт для всех модулей (store, ods, export, sync, calendar, ui).
// Менять только через оркестратора — от этих типов зависят все модули.
// Описание полей — SPEC.md §5.

export type ISODate = string;      // 'YYYY-MM-DD'
export type ISODateTime = string;  // new Date().toISOString()
export type YearMonth = string;    // 'YYYY-MM'

/**
 * Тип задачи — id из Settings.taskTypes. Все типы равноправны: любой можно переименовать,
 * перекрасить, переключить «с деньгами» и удалить. Задаёт цвет записи везде.
 */
export type EntryType = string;

/** Определение типа задачи (настраивается в «Настройках»). */
export interface TaskTypeDef {
  id: string;
  name: string;
  color: string;
  /** Тип с деньгами: показывает поля денег и входит в оборот. */
  money: boolean;
  /** Tombstone: тип удалён (чтобы синхронизация не вернула его). */
  deleted?: boolean;
}

/**
 * Вид записи: job — задача с датой, work — работа без даты (засчитывается в месяц учёта),
 * payment — оплата/предоплата, event — дело, note — заметка.
 */
export type EntryKind = 'job' | 'work' | 'payment' | 'event' | 'note';

/** Статус записи. id хранятся в данных и не переименовываются; подписи — STATUS_LABELS. */
export type EntryStatus = 'lead' | 'booked' | 'shot' | 'editing' | 'delivered' | 'done' | 'cancelled';

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
  /** Типы задач. Читать через taskTypes()/typeDef() из model/taskTypes. */
  taskTypes: TaskTypeDef[];
  /**
   * Тип по умолчанию: новые записи и записи с суммой при быстром вводе и импорте.
   * Не задан или удалён — первый живой тип с деньгами (см. defaultTypeId()).
   */
  defaultTypeId?: string;
  /**
   * Тип для дел без денег (запись без суммы и без признаков работы).
   * Не задан или удалён — первый живой тип без денег, иначе тип по умолчанию (см. defaultNoMoneyTypeId()).
   */
  defaultNoMoneyTypeId?: string;
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

/** Категории нового документа; пользователь правит список в «Настройках». */
export const DEFAULT_CATEGORIES = [
  'консультация',
  'проект',
  'встреча',
  'поддержка',
  'разработка',
  'дизайн',
  'обучение',
  'прочее',
];

/**
 * Типы задач нового документа — обычные элементы списка: их можно переименовать, перекрасить и удалить.
 * id 'main' | 'joint' | 'personal' сохранены, чтобы записи старых документов не потеряли тип.
 */
export const DEFAULT_TASK_TYPES: readonly TaskTypeDef[] = [
  { id: 'main', name: 'Основная работа', color: '#a5d6a7', money: true },
  { id: 'joint', name: 'Совместная работа', color: '#80deea', money: true },
  { id: 'personal', name: 'Личное', color: '#fff59d', money: false },
];

export const DEFAULT_SETTINGS: Settings = {
  netFactor: 0.67,
  categories: DEFAULT_CATEGORIES,
  taskTypes: DEFAULT_TASK_TYPES.map((t) => ({ ...t })),
  intermediaryOverdueDays: 14,
  calendar: {
    enabled: false,
    calendarName: 'Трекер',
    includeMoney: false,
    personalMode: 'full',
    reminderMinutes: [24 * 60, 120],
    onCancel: 'delete',
  },
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export const STATUS_LABELS: Record<EntryStatus, string> = {
  lead: 'Заявка',
  booked: 'Запланировано',
  shot: 'Сделано',
  editing: 'В работе',
  delivered: 'Сдано',
  done: 'Закрыто',
  cancelled: 'Отменено',
};

export const KIND_LABELS: Record<EntryKind, string> = {
  job: 'Задача',
  work: 'Работа без даты',
  payment: 'Оплата',
  event: 'Дело',
  note: 'Заметка',
};

export const WHERE_LABELS: Record<MoneyWhere, string> = {
  client: 'У клиента',
  intermediary: 'У посредника',
  owner: 'Получено',
};
