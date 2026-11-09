import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../model/entry';
import { NeedsAuthError } from './auth';
import { createDriveClient, DriveHttpError, OfflineError, type FetchLike } from './drive';

interface Call {
  url: string;
  method: string;
  body?: string;
  auth?: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(handler: (c: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const c: Call = {
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
        auth: new Headers(init?.headers).get('Authorization'),
      };
      calls.push(c);
      return handler(c);
    },
  };
}

const token = async () => 'tok';

describe('drive client', () => {
  it('ищет tracker.json в appDataFolder и передаёт токен', async () => {
    const f = fakeFetch(() => json({ files: [{ id: 'old', version: '7' }, { id: 'new', version: '1' }] }));
    const d = createDriveClient(token, f.fetch);
    expect(await d.findDataFile()).toEqual({ id: 'old', version: '7' });
    const u = new URL(f.calls[0].url);
    expect(u.searchParams.get('spaces')).toBe('appDataFolder');
    expect(u.searchParams.get('q')).toContain("name='tracker.json'");
    expect(f.calls[0].auth).toBe('Bearer tok');
  });

  it('download: сначала версия, потом содержимое', async () => {
    const f = fakeFetch((c) =>
      c.url.includes('alt=media') ? new Response(JSON.stringify(emptyDoc())) : json({ id: 'f', version: '42' }),
    );
    const d = createDriveClient(token, f.fetch);
    const r = await d.download('f');
    expect(r.version).toBe('42');
    expect(r.doc.schemaVersion).toBe(1);
    expect(f.calls[0].url).toContain('fields=id,version'); // metadata первой
    expect(f.calls[1].url).toContain('alt=media');
  });

  it('401 → NeedsAuthError, обрыв сети → OfflineError, прочее → DriveHttpError', async () => {
    await expect(createDriveClient(token, fakeFetch(() => json({}, 401)).fetch).getVersion('f')).rejects.toBeInstanceOf(
      NeedsAuthError,
    );
    const offline: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(createDriveClient(token, offline).getVersion('f')).rejects.toBeInstanceOf(OfflineError);
    const e = await createDriveClient(token, fakeFetch(() => json({ error: { message: 'Rate limit' } }, 403)).fetch)
      .getVersion('f')
      .catch((x) => x);
    expect(e).toBeInstanceOf(DriveHttpError);
    expect(e.status).toBe(403);
    expect(e.message).toContain('Rate limit');
  });

  it('создание файла — multipart в appDataFolder, обновление — PATCH media', async () => {
    const f = fakeFetch(() => json({ id: 'f', version: '2' }));
    const d = createDriveClient(token, f.fetch);
    await d.createDataFile(emptyDoc());
    expect(f.calls[0].method).toBe('POST');
    expect(f.calls[0].url).toContain('uploadType=multipart');
    expect(f.calls[0].body).toContain('"parents":["appDataFolder"]');
    await d.updateDataFile('f', emptyDoc());
    expect(f.calls[1].method).toBe('PATCH');
    expect(f.calls[1].url).toContain('/upload/drive/v3/files/f?uploadType=media');
  });

  it('бэкап: создаёт папку «Трекер», пишет файл дня и удаляет старые сверх 30', async () => {
    const existing = Array.from({ length: 31 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
      return { id: 'b' + d, name: `backup-${d}.json` };
    });
    existing.push({ id: 'other', name: 'Выгрузка.ods' });
    const f = fakeFetch((c) => {
      const u = new URL(c.url);
      const q = u.searchParams.get('q') ?? '';
      if (c.method === 'GET' && q.includes("mimeType='application/vnd.google-apps.folder'")) return json({ files: [] });
      if (c.method === 'POST' && u.pathname === '/drive/v3/files') return json({ id: 'folder' });
      if (c.method === 'GET' && q.includes("'folder' in parents")) return json({ files: existing });
      if (c.method === 'POST' && u.pathname === '/upload/drive/v3/files') return json({ id: 'new', version: '1' });
      if (c.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error('неожиданный запрос ' + c.method + ' ' + c.url);
    });
    const d = createDriveClient(token, f.fetch);
    await d.writeDailyBackup(emptyDoc(), '2026-11-09');
    const folderCreate = f.calls.find((c) => c.method === 'POST' && c.url.includes('/drive/v3/files?'));
    expect(JSON.parse(folderCreate!.body!)).toMatchObject({ name: 'Трекер' });
    const upload = f.calls.find((c) => c.url.includes('uploadType=multipart'))!;
    expect(upload.body).toContain('"name":"backup-2026-11-09.json"');
    // 31 старый + 1 новый = 32 → удалить 2 самых старых; чужие файлы не трогать.
    const deleted = f.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop());
    expect(deleted.sort()).toEqual(['b2026-10-01', 'b2026-10-02']);
  });
});
