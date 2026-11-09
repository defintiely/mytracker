// Тонкий клиент Google Drive REST v3 через fetch (без gapi).
//
// Данные: appDataFolder/tracker.json (скоуп drive.appdata) — пользователь его не видит.
// Бэкапы: видимая папка «Трекер» (скоуп drive.file) — backup-YYYY-MM-DD.json, хранятся последние 30.
//
// ОГРАНИЧЕНИЕ АТОМАРНОСТИ. Drive v3 не поддерживает условную запись (If-Match / ETag) для загрузки
// содержимого (uploadType=media). Поэтому «записать, только если файл не изменился с момента чтения»
// реализовано так: перед записью перечитываем metadata `version` и сравниваем с версией, полученной
// при скачивании; если отличается — синхронизатор повторяет цикл (скачать → слить → записать).
// Между проверкой версии и самой записью остаётся окно в десятки–сотни миллисекунд: если второе
// устройство запишет файл ровно в это окно, его запись будет перезаписана. Его правки остаются в его
// локальной копии и base-снимке; в следующем цикле merge распознаёт в Drive откат (метка поля старше,
// чем в base) и оставляет локальную правку, а цикл снова записывает её в Drive. Записавшее устройство
// при этом видит версию больше ожидаемой (прочитанная + 1) и сразу запускает ещё один цикл.
import { NeedsAuthError } from './auth';
import { OfflineError } from './errors';

export { OfflineError };
import type { TrackerDoc } from '../model/types';

export const DATA_FILE_NAME = 'tracker.json';
export const BACKUP_FOLDER_NAME = 'Трекер';
export const BACKUPS_TO_KEEP = 30;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const BACKUP_RE = /^backup-\d{4}-\d{2}-\d{2}\.json$/;

/** Ответ Drive с кодом ошибки (кроме 401 — он превращается в NeedsAuthError). */
export class DriveHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RemoteFile {
  id: string;
  version: string;
}

export interface DriveApi {
  /** Найти tracker.json в appDataFolder (самый старый, если их несколько). */
  findDataFile(): Promise<RemoteFile | undefined>;
  /** Скачать содержимое; версия читается ДО содержимого, поэтому может быть только «старее». */
  download(fileId: string): Promise<{ doc: TrackerDoc; version: string }>;
  /** Текущая версия файла (metadata). */
  getVersion(fileId: string): Promise<string>;
  createDataFile(doc: TrackerDoc): Promise<RemoteFile>;
  updateDataFile(fileId: string, doc: TrackerDoc): Promise<RemoteFile>;
  /** Email владельца Drive (about.get, работает со скоупом drive.*). */
  getAccountEmail(): Promise<string | undefined>;
  /** Записать backup-YYYY-MM-DD.json в папку «Трекер» и удалить старые сверх 30. */
  writeDailyBackup(doc: TrackerDoc, date: string): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface DriveFileMeta {
  id: string;
  name?: string;
  version?: string;
  createdTime?: string;
}

export function createDriveClient(
  getToken: () => Promise<string>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): DriveApi {
  let backupFolderId: string | undefined;

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + token);
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, headers });
    } catch (e) {
      // fetch бросает TypeError, когда запрос не дошёл (нет сети, DNS, CORS-обрыв).
      throw new OfflineError(e instanceof Error ? e.message : String(e));
    }
    if (res.status === 401) throw new NeedsAuthError();
    if (!res.ok) {
      let msg = `Drive: HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) msg += ': ' + body.error.message;
      } catch {
        /* тело не JSON */
      }
      throw new DriveHttpError(res.status, msg);
    }
    return res;
  }

  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await (await request(url, init)).json()) as T;
  }

  async function listFiles(q: string, spaces: 'drive' | 'appDataFolder', orderBy: string): Promise<DriveFileMeta[]> {
    const files: DriveFileMeta[] = [];
    let pageToken: string | undefined;
    do {
      const p = new URLSearchParams({
        q,
        spaces,
        orderBy,
        pageSize: '100',
        fields: 'nextPageToken,files(id,name,version,createdTime)',
      });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await json<{ files?: DriveFileMeta[]; nextPageToken?: string }>(`${API}/files?${p}`);
      files.push(...(r.files ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return files;
  }

  function multipartBody(metadata: object, content: string): { body: string; contentType: string } {
    const boundary = 'wlt-' + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }

  async function createFile(metadata: object, content: string): Promise<DriveFileMeta> {
    const { body, contentType } = multipartBody(metadata, content);
    return json<DriveFileMeta>(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
  }

  async function updateContent(fileId: string, content: string): Promise<DriveFileMeta> {
    return json<DriveFileMeta>(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,version`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: content,
    });
  }

  function toRemote(m: DriveFileMeta): RemoteFile {
    return { id: m.id, version: String(m.version ?? '') };
  }

  async function ensureBackupFolder(): Promise<string> {
    if (backupFolderId) return backupFolderId;
    const found = await listFiles(
      `name='${BACKUP_FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`,
      'drive',
      'createdTime',
    );
    if (found.length) {
      backupFolderId = found[0].id;
    } else {
      const created = await json<DriveFileMeta>(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType: FOLDER_MIME }),
      });
      backupFolderId = created.id;
    }
    return backupFolderId;
  }

  return {
    async findDataFile() {
      const files = await listFiles(`name='${DATA_FILE_NAME}' and trashed=false`, 'appDataFolder', 'createdTime');
      return files.length ? toRemote(files[0]) : undefined;
    },

    async download(fileId) {
      const version = await this.getVersion(fileId);
      const res = await request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
      const text = await res.text();
      let doc: TrackerDoc;
      try {
        doc = JSON.parse(text) as TrackerDoc;
      } catch {
        throw new DriveHttpError(422, 'tracker.json в Drive повреждён (не JSON)');
      }
      return { doc, version };
    },

    async getVersion(fileId) {
      const m = await json<DriveFileMeta>(`${API}/files/${encodeURIComponent(fileId)}?fields=id,version`);
      return String(m.version ?? '');
    },

    async createDataFile(doc) {
      return toRemote(await createFile({ name: DATA_FILE_NAME, parents: ['appDataFolder'] }, JSON.stringify(doc)));
    },

    async updateDataFile(fileId, doc) {
      return toRemote(await updateContent(fileId, JSON.stringify(doc)));
    },

    async getAccountEmail() {
      const r = await json<{ user?: { emailAddress?: string } }>(`${API}/about?fields=user(emailAddress)`);
      return r.user?.emailAddress;
    },

    async writeDailyBackup(doc, date) {
      try {
        await writeBackup(doc, date);
      } catch (e) {
        // Папку удалили, пока приложение было открыто, — найти/создать заново один раз.
        if (!(e instanceof DriveHttpError && e.status === 404) || !backupFolderId) throw e;
        backupFolderId = undefined;
        await writeBackup(doc, date);
      }
    },
  };

  async function writeBackup(doc: TrackerDoc, date: string): Promise<void> {
    {
      const folderId = await ensureBackupFolder();
      const name = `backup-${date}.json`;
      const existing = await listFiles(`'${folderId}' in parents and trashed=false`, 'drive', 'name desc');
      const backups = existing.filter((f) => f.name && BACKUP_RE.test(f.name));
      const today = backups.find((f) => f.name === name);
      const content = JSON.stringify(doc);
      if (today) await updateContent(today.id, content);
      else {
        await createFile({ name, parents: [folderId], mimeType: 'application/json' }, content);
        backups.push({ id: '', name });
      }
      // Хранить последние BACKUPS_TO_KEEP по имени (дата в имени сортируется как строка).
      backups.sort((a, b) => (a.name! < b.name! ? 1 : a.name! > b.name! ? -1 : 0));
      for (const old of backups.slice(BACKUPS_TO_KEEP)) {
        if (!old.id) continue;
        try {
          await request(`${API}/files/${encodeURIComponent(old.id)}`, { method: 'DELETE' });
        } catch (e) {
          if (!(e instanceof DriveHttpError && e.status === 404)) throw e;
        }
      }
    }
  }
}
