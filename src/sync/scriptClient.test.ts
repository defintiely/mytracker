import { describe, expect, it } from 'vitest';
import { OfflineError, ScriptCallError } from './errors';
import {
  connectionLink,
  createScriptClient,
  generateKey,
  getPendingKey,
  parseConnectionLink,
  MSG_NOT_PUBLIC,
} from './scriptClient';

const URL1 = 'https://script.google.com/macros/s/AKfycbx_abc-123/exec';

function fakeFetch(respond: (body: Record<string, unknown>) => { status?: number; text: string } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = respond(JSON.parse(String(init.body)));
    if (r instanceof Error) throw r;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.text };
  };
  return { fn, calls };
}

describe('scriptClient', () => {
  it('ключ: 32 буквы/цифры, каждый раз новый; pendingKey сохраняется', () => {
    const k = generateKey();
    expect(k).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(generateKey()).not.toBe(k);
    expect(getPendingKey()).toBe(getPendingKey());
  });

  it('разбор ссылки веб-приложения и ссылки подключения', () => {
    expect(parseConnectionLink(`  ${URL1} `)).toEqual({ url: URL1 });
    expect(parseConnectionLink(`${URL1}#k=Abc123`)).toEqual({ url: URL1, key: 'Abc123' });
    expect(parseConnectionLink(connectionLink({ url: URL1, key: 'Zz9' }))).toEqual({ url: URL1, key: 'Zz9' });
    expect(parseConnectionLink('https://script.google.com/a/macros/firma.ru/s/XYZ/exec')).toEqual({
      url: 'https://script.google.com/a/macros/firma.ru/s/XYZ/exec',
    });
    expect(parseConnectionLink('https://script.google.com/macros/s/XYZ/dev')).toBeUndefined();
    expect(parseConnectionLink('https://script.google.com/home/projects/XYZ/edit')).toBeUndefined();
    expect(parseConnectionLink('не ссылка')).toBeUndefined();
  });

  it('запрос: POST text/plain с ключом, ответ JSON', async () => {
    const f = fakeFetch(() => ({ text: JSON.stringify({ ok: true, protocol: 1, email: 'a@b.c' }) }));
    const c = createScriptClient(() => ({ url: URL1, key: 'KEY' }), f.fn);
    expect(await c.ping()).toEqual({ ok: true, protocol: 1, email: 'a@b.c' });
    expect(f.calls[0].url).toBe(URL1);
    expect(f.calls[0].init).toMatchObject({ method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ k: 'KEY', action: 'ping' });
  });

  it('ошибки: сеть → OfflineError, HTML → «доступ Все», forbidden → неверный ключ, conflict — значением', async () => {
    const conn = () => ({ url: URL1, key: 'KEY' });
    await expect(createScriptClient(conn, fakeFetch(() => new TypeError('Failed to fetch')).fn).load()).rejects.toBeInstanceOf(OfflineError);
    await expect(createScriptClient(conn, fakeFetch(() => ({ text: '<html>Вход</html>' })).fn).load()).rejects.toThrow(MSG_NOT_PUBLIC);
    const forbidden = createScriptClient(conn, fakeFetch(() => ({ text: '{"ok":false,"code":"forbidden","error":"x"}' })).fn);
    await expect(forbidden.load()).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/Неверный ключ/) });
    const conflict = createScriptClient(conn, fakeFetch(() => ({ text: '{"ok":false,"code":"conflict","error":"x","rev":7}' })).fn);
    expect(await conflict.save({} as never, 1)).toMatchObject({ ok: false, code: 'conflict', rev: 7 });
    const internal = createScriptClient(conn, fakeFetch(() => ({ text: '{"ok":false,"code":"internal","error":"Квота"}' })).fn);
    await expect(internal.load()).rejects.toThrow(/Квота/);
    const none = createScriptClient(() => undefined);
    expect(none.configured()).toBe(false);
    await expect(none.load()).rejects.toBeInstanceOf(ScriptCallError);
  });
});
