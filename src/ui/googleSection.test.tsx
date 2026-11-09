// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { store } from '../store/store';
import { emptyDoc } from '../model/entry';
import { clearConnection, getConnection } from '../sync/scriptClient';
import { App } from '../App';

const URL1 = 'https://script.google.com/macros/s/AKfyc_test/exec';

beforeAll(async () => {
  await store.load();
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* нет хранилища */
  }
  clearConnection();
  store.replaceDoc(emptyDoc());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Подключение Google Drive через Apps Script', () => {
  it('из шапки ведёт в настройки, проверяет ссылку и подключает', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        const res =
          body.action === 'ping'
            ? { ok: true, protocol: 1, email: 'me@example.com' }
            : body.action === 'load'
              ? { ok: true, doc: null, rev: 0 }
              : body.action === 'save'
                ? { ok: true, rev: 1 }
                : { ok: false, code: 'bad_request', error: 'нет' };
        return { ok: true, status: 200, text: async () => JSON.stringify(res) };
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Подключить Google Drive' }));
    expect(screen.getByText('Google Drive через Apps Script')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Скопировать код скрипта' })).toBeTruthy();
    expect(screen.queryByText(/Client ID/)).toBeNull();

    const input = screen.getByLabelText('Ссылка веб-приложения');
    fireEvent.change(input, { target: { value: 'https://script.google.com/macros/s/AKfyc_test/dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(screen.getByText(/тестовая ссылка/)).toBeTruthy();

    fireEvent.change(input, { target: { value: URL1 } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(getConnection()?.url).toBe(URL1);
    expect(bodies[0]).toMatchObject({ action: 'ping' });
    const key = getConnection()!.key;
    expect(bodies[0].k).toBe(key);
    expect((screen.getByLabelText('Ссылка для телефона и других устройств') as HTMLInputElement).value).toBe(`${URL1}#k=${key}`);
  });
});
