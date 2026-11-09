// Исполняет собранный текст Apps Script в Node с фейками сервисов Google.
import { describe, expect, it } from 'vitest';
import { buildScriptSource } from './scriptSource';
import { SCRIPT_PROTOCOL_VERSION } from './scriptApi';

const KEY = 'test-key-1234567890abcdef';

class FakeFile {
  trashed = false;
  constructor(
    public name: string,
    public content: string,
  ) {}
  getName() {
    return this.name;
  }
  isTrashed() {
    return this.trashed;
  }
  setTrashed(v: boolean) {
    this.trashed = v;
  }
  setContent(c: string) {
    this.content = c;
    return this;
  }
  getBlob() {
    return { getDataAsString: () => this.content };
  }
}

function iter<T>(items: T[]) {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
}

class FakeFolder {
  folders: FakeFolder[] = [];
  files: FakeFile[] = [];
  trashed = false;
  constructor(public name: string) {}
  isTrashed() {
    return this.trashed;
  }
  getFoldersByName(n: string) {
    return iter(this.folders.filter((f) => f.name === n));
  }
  getFilesByName(n: string) {
    return iter(this.files.filter((f) => f.name === n));
  }
  getFiles() {
    return iter([...this.files]);
  }
  createFolder(n: string) {
    const f = new FakeFolder(n);
    this.folders.push(f);
    return f;
  }
  createFile(n: string, content: string) {
    const f = new FakeFile(n, content);
    this.files.push(f);
    return f;
  }
  folder(n: string) {
    return this.folders.find((f) => f.name === n && !f.trashed);
  }
  liveFiles() {
    return this.files.filter((f) => !f.trashed);
  }
}

interface Env {
  root: FakeFolder;
  props: Map<string, string>;
  today: { value: string };
  locks: number;
  post(body: unknown): Record<string, unknown>;
  postRaw(text: string): Record<string, unknown>;
  get(): Record<string, unknown>;
}

function makeEnv(): Env {
  const root = new FakeFolder('root');
  const props = new Map<string, string>();
  const today = { value: '2026-11-09' };
  const env = { root, props, today, locks: 0 } as Env;
  const services = {
    DriveApp: { getRootFolder: () => root },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => (props.has(k) ? props.get(k)! : null),
        setProperty: (k: string, v: string) => props.set(k, String(v)),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          env.locks++;
        },
        releaseLock: () => {
          env.locks--;
        },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text: string) => ({ text, setMimeType: function () { return this; } }),
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }),
      getScriptTimeZone: () => 'Europe/London',
    },
    Utilities: { formatDate: () => today.value },
    CalendarApp: {},
  };
  const names = Object.keys(services);
  const factory = new Function(...names, buildScriptSource(KEY) + '\nreturn { doPost: doPost, doGet: doGet };');
  const api = factory(...names.map((n) => services[n as keyof typeof services])) as {
    doPost(e: unknown): { text: string };
    doGet(e: unknown): { text: string };
  };
  env.postRaw = (text) => JSON.parse(api.doPost({ postData: { contents: text } }).text);
  env.post = (body) => env.postRaw(JSON.stringify(body));
  env.get = () => JSON.parse(api.doGet({}).text);
  return env;
}

const doc = (title: string) => ({ schemaVersion: 1, entries: [{ id: title, title }], contacts: [], sources: [], settings: {} });

function dataFile(env: Env) {
  return env.root.folder('Трекер')?.liveFiles().find((f) => f.name === 'tracker.json');
}

describe('Apps Script трекера', () => {
  it('не содержит import/export и собирается с ключом', () => {
    const src = buildScriptSource(KEY);
    expect(src).toContain(`const KEY = '${KEY}';`);
    expect(src).not.toMatch(/^\s*(import|export)\s/m);
    expect(src).toContain('function handleCalendar_');
    expect(() => buildScriptSource("bad'key")).toThrow();
  });

  it('чужой ключ → forbidden, ничего не создаётся', () => {
    const env = makeEnv();
    expect(env.post({ k: 'другой', action: 'load' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(env.post({ action: 'save', doc: doc('a'), baseRev: 0 })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(env.root.folders).toHaveLength(0);
  });

  it('некорректный JSON и неизвестное действие → bad_request', () => {
    const env = makeEnv();
    expect(env.postRaw('{не json')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(env.postRaw('')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(env.post({ k: KEY, action: 'нет такого' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(env.post({ k: KEY, action: 'save', baseRev: 0 })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('ping отдаёт протокол и email; doGet отвечает JSON', () => {
    const env = makeEnv();
    expect(env.post({ k: KEY, action: 'ping' })).toEqual({ ok: true, protocol: SCRIPT_PROTOCOL_VERSION, email: 'owner@example.com' });
    expect(env.get()).toMatchObject({ ok: true });
  });

  it('load пустой → doc null, rev 0; save → load возвращает doc и rev 1', () => {
    const env = makeEnv();
    expect(env.post({ k: KEY, action: 'load' })).toEqual({ ok: true, doc: null, rev: 0 });
    expect(env.post({ k: KEY, action: 'save', doc: doc('a'), baseRev: 0 })).toEqual({ ok: true, rev: 1 });
    expect(env.post({ k: KEY, action: 'load' })).toEqual({ ok: true, doc: doc('a'), rev: 1 });
    expect(env.post({ k: KEY, action: 'save', doc: doc('b'), baseRev: 1 })).toEqual({ ok: true, rev: 2 });
    expect(env.post({ k: KEY, action: 'load' })).toEqual({ ok: true, doc: doc('b'), rev: 2 });
    expect(env.root.folders.map((f) => f.name)).toEqual(['Трекер']);
    expect(env.locks).toBe(0); // блокировка отпущена
  });

  it('save с устаревшим baseRev → conflict, файл не изменился', () => {
    const env = makeEnv();
    env.post({ k: KEY, action: 'save', doc: doc('a'), baseRev: 0 });
    env.post({ k: KEY, action: 'save', doc: doc('b'), baseRev: 1 });
    const before = dataFile(env)!.content;
    expect(env.post({ k: KEY, action: 'save', doc: doc('c'), baseRev: 1 })).toMatchObject({ ok: false, code: 'conflict', rev: 2 });
    expect(env.post({ k: KEY, action: 'save', doc: doc('c'), baseRev: 0 })).toMatchObject({ ok: false, code: 'conflict', rev: 2 });
    expect(dataFile(env)!.content).toBe(before);
    expect(env.props.get('rev')).toBe('2');
    expect(env.locks).toBe(0);
  });

  it('файл в корзине считается отсутствующим', () => {
    const env = makeEnv();
    env.post({ k: KEY, action: 'save', doc: doc('a'), baseRev: 0 });
    dataFile(env)!.setTrashed(true);
    expect(env.post({ k: KEY, action: 'load' })).toEqual({ ok: true, doc: null, rev: 1 });
    expect(env.post({ k: KEY, action: 'save', doc: doc('b'), baseRev: 1 })).toEqual({ ok: true, rev: 2 });
    expect(JSON.parse(dataFile(env)!.content)).toEqual(doc('b'));
  });

  it('бэкап — при первой записи за день, хранятся 30 последних', () => {
    const env = makeEnv();
    env.post({ k: KEY, action: 'save', doc: doc('d0'), baseRev: 0 }); // файла не было — копировать нечего
    const backups = () => env.root.folder('Трекер')?.folder('Бэкапы');
    expect(backups()?.liveFiles() ?? []).toHaveLength(0);

    env.post({ k: KEY, action: 'save', doc: doc('d1'), baseRev: 1 });
    expect(backups()!.liveFiles().map((f) => f.name)).toEqual(['backup-2026-11-09.json']);
    expect(JSON.parse(backups()!.liveFiles()[0].content)).toEqual(doc('d0')); // снимок ДО записи
    env.post({ k: KEY, action: 'save', doc: doc('d2'), baseRev: 2 });
    expect(backups()!.liveFiles()).toHaveLength(1); // второй раз за день — без копии
    expect(JSON.parse(backups()!.liveFiles()[0].content)).toEqual(doc('d0'));

    let rev = 3;
    for (let day = 1; day <= 35; day++) {
      env.today.value = `2026-12-${String(day).padStart(2, '0')}`;
      expect(env.post({ k: KEY, action: 'save', doc: doc('x' + day), baseRev: rev })).toEqual({ ok: true, rev: rev + 1 });
      rev++;
    }
    const names = backups()!.liveFiles().map((f) => f.name).sort();
    expect(names).toHaveLength(30);
    expect(names[names.length - 1]).toBe('backup-2026-12-35.json');
    expect(names[0]).toBe('backup-2026-12-06.json');
    expect(names).not.toContain('backup-2026-11-09.json');
  });

  it('ошибка внутри действия → internal с текстом', () => {
    const env = makeEnv();
    env.root.getFoldersByName = () => {
      throw new Error('Drive недоступен');
    };
    expect(env.post({ k: KEY, action: 'load' })).toEqual({ ok: false, code: 'internal', error: 'Drive недоступен' });
  });

  it('нет разрешения (на любом языке) → подсказка запустить setup', () => {
    const env = makeEnv();
    env.root.getFoldersByName = () => {
      throw new Error(
        'Δεν έχετε δικαίωμα κλήσης του DriveApp.getRootFolder. Απαιτούμενες άδειες: (https://www.googleapis.com/auth/drive)',
      );
    };
    const r = env.post({ k: KEY, action: 'load' }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/функцию setup/);
  });

  it('в скрипте есть функция setup для выдачи разрешений', () => {
    expect(buildScriptSource(KEY)).toMatch(/function setup\(\) \{\s*DriveApp\.getRootFolder\(\);\s*CalendarApp\.getAllOwnedCalendars\(\);/);
  });
});
