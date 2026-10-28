import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { toast } from 'sonner';
import {
  AuthGate,
  completeRegistration,
  getAuthFormReset,
  readAuthJson,
} from '../components/AuthGate';
import { useAuthStore } from './auth';
import { useAppStore } from './store';

class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe('authentication state', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    useAuthStore.setState({
      status: 'checking',
      user: null,
      sessionExpired: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not render protected app content while the session is being checked', () => {
    const markup = renderToString(
      createElement(
        AuthGate,
        null,
        createElement('div', null, 'PRIVATE APP'),
      ),
    );
    expect(markup).toContain('Verificando sua sessão');
    expect(markup).not.toContain('PRIVATE APP');
  });

  it('shows a clear error for an HTML response from an auth endpoint', async () => {
    const response = new Response('<!DOCTYPE html><html></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    await expect(readAuthJson(response)).rejects.toThrow(
      'O servidor não respondeu como esperado. Verifique se o backend está rodando e atualizado.',
    );
  });

  it('shows success and switches to login after registration', () => {
    const successToast = vi.spyOn(toast, 'success').mockReturnValue('toast-id');

    expect(completeRegistration('  Alice  ')).toEqual({
      mode: 'login',
      name: 'Alice',
      password: '',
      confirmation: '',
      showPassword: false,
      busy: false,
      error: '',
    });
    expect(successToast).toHaveBeenCalledWith(
      'Conta criada com sucesso! Faça login para continuar.',
    );
  });

  it('uses a clean login form after logout or a global 401 transition', () => {
    expect(getAuthFormReset()).toEqual({
      mode: 'login',
      name: '',
      password: '',
      confirmation: '',
      showPassword: false,
      busy: false,
      error: '',
    });
  });

  it('exposes the authenticated user role and clears it on logout', () => {
    useAuthStore.getState().setUser({
      id: 'user-1',
      name: 'Alice',
      role: 'admin',
    });
    expect(useAuthStore.getState().user?.role).toBe('admin');
    useAuthStore.getState().clearUser();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  it('isolates cached conversations by user and deletes the current user cache on logout', () => {
    const aliceConversation = {
      id: 'alice-chat',
      title: 'Alice',
      createdAt: 1,
      updatedAt: 1,
      model: 'test-model',
      messages: [],
    };
    const bobConversation = {
      ...aliceConversation,
      id: 'bob-chat',
      title: 'Bob',
    };
    const store = useAppStore.getState();
    store.activateUserConversations('alice-id', [aliceConversation]);
    expect(localStorage.getItem('openjarvis-conversations:alice-id')).not.toBeNull();
    store.clearUserData();
    expect(localStorage.getItem('openjarvis-conversations:alice-id')).toBeNull();

    useAppStore.getState().activateUserConversations('bob-id', [bobConversation]);
    expect(useAppStore.getState().conversations).toEqual([bobConversation]);
    expect(localStorage.getItem('openjarvis-conversations:alice-id')).toBeNull();
  });
});
