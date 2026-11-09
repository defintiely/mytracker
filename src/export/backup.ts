import type { TrackerDoc } from '../model/types';
import { DEFAULT_SETTINGS } from '../model/types';

export const BACKUP_APP = 'work-life-tracker';

interface BackupWrapper {
  app: typeof BACKUP_APP;
  exportedAt: string;
  doc: TrackerDoc;
}

/** Полный бэкап в JSON. */
export function exportBackup(doc: TrackerDoc): string {
  const wrapper: BackupWrapper = { app: BACKUP_APP, exportedAt: new Date().toISOString(), doc };
  return JSON.stringify(wrapper, null, 2);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error('Не удалось восстановить бэкап: ' + msg);
}

function checkItems(list: unknown[], what: string): void {
  list.forEach((it, i) => {
    if (!isObject(it) || typeof it.id !== 'string' || !it.id) {
      fail(`${what}: элемент №${i + 1} повреждён (нет id).`);
    }
  });
}

/** Разобрать бэкап; бросает понятную ошибку, если файл не тот. Принимает и обёртку, и голый TrackerDoc. */
export function parseBackup(text: string): TrackerDoc {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    fail('файл не является JSON. Выберите файл бэкапа трекера (.json).');
  }
  if (!isObject(data)) fail('в файле нет данных трекера.');

  let doc: unknown = data;
  if ('app' in data || 'doc' in data) {
    if (data.app !== BACKUP_APP) {
      fail(`это бэкап другого приложения («${String(data.app)}»), а не трекера съёмок.`);
    }
    doc = data.doc;
    if (!isObject(doc)) fail('в бэкапе нет документа трекера (поле doc).');
  }
  const d = doc as Record<string, unknown>;

  if (!('schemaVersion' in d)) fail('файл не похож на бэкап трекера: нет schemaVersion.');
  if (d.schemaVersion !== 1) {
    fail(`неподдерживаемая версия данных (${String(d.schemaVersion)}); это приложение понимает версию 1.`);
  }
  for (const [key, label] of [
    ['entries', 'записи'],
    ['contacts', 'контакты'],
    ['sources', 'источники'],
  ] as const) {
    const v = d[key];
    if (!Array.isArray(v)) fail(`повреждён список «${label}» (${key}).`);
    checkItems(v, `список «${label}»`);
  }
  if (!isObject(d.settings)) fail('нет настроек (settings).');

  const s = d.settings as Record<string, unknown>;
  const settings = {
    ...DEFAULT_SETTINGS,
    ...s,
    typeColors: { ...DEFAULT_SETTINGS.typeColors, ...(isObject(s.typeColors) ? s.typeColors : {}) },
    calendar: { ...DEFAULT_SETTINGS.calendar, ...(isObject(s.calendar) ? s.calendar : {}) },
  };
  if (typeof settings.netFactor !== 'number' || !Number.isFinite(settings.netFactor)) {
    fail('в настройках неверный коэффициент «чистыми» (netFactor).');
  }

  return {
    schemaVersion: 1,
    entries: d.entries as TrackerDoc['entries'],
    contacts: d.contacts as TrackerDoc['contacts'],
    sources: d.sources as TrackerDoc['sources'],
    settings: settings as TrackerDoc['settings'],
  };
}
