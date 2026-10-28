import { create } from 'zustand';

export interface AuthUser {
  id: string;
  name: string;
  role: 'admin' | 'user';
}

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  sessionExpired: boolean;
  setUser: (user: AuthUser) => void;
  clearUser: (sessionExpired?: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'checking',
  user: null,
  sessionExpired: false,
  setUser: (user) => set({ status: 'authenticated', user, sessionExpired: false }),
  clearUser: (sessionExpired = false) =>
    set({ status: 'unauthenticated', user: null, sessionExpired }),
}));

export function useAuth(): AuthState {
  return useAuthStore();
}
