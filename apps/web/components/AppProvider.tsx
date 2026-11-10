'use client';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { API, ApiError, request } from '@/lib/api';
import type { Stats, User } from '@/lib/types';

type Toast = {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
};
type Ctx = {
  user: User;
  stats: Stats;
  /** Bumps when the server pushes a change; lists re-fetch on it. */
  tick: number;
  refresh: () => void;
  toast: (message: string, kind?: 'info' | 'error', action?: Toast['action']) => void;
  signOut: () => Promise<void>;
};
const AppContext = createContext<Ctx | null>(null);
export const useApp = () => {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
};

const emptyStats: Stats = { scheduled: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 };

/** Loads the session once, guards every signed-in page, and owns toasts and live updates. */
export function AppProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [tick, setTick] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fatal, setFatal] = useState('');
  const nextId = useRef(1);

  const loadStats = useCallback(async () => {
    try {
      setStats(await request('/api/emails/stats'));
    } catch {
      /* counts are decoration; the list shows real errors */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    request('/auth/me')
      .then(async ({ user }) => {
        if (cancelled) return;
        setUser(user);
        await loadStats();
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) router.replace('/login');
        else setFatal(error instanceof Error ? error.message : 'Could not reach the server.');
      });
    return () => {
      cancelled = true;
    };
  }, [router, loadStats]);

  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    // The API pushes status changes; coalesce so a burst causes one refresh per second.
    const source = new EventSource(`${API}/api/events`, { withCredentials: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onmessage = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setTick((value) => value + 1);
        void loadStats();
      }, 1000);
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [signedIn, loadStats]);

  const toast = useCallback<Ctx['toast']>((message, kind = 'info', action) => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { id, message, kind, action }]);
    setTimeout(
      () => setToasts((list) => list.filter((item) => item.id !== id)),
      action ? 7000 : 4500,
    );
  }, []);

  const refresh = useCallback(() => {
    setTick((value) => value + 1);
    void loadStats();
  }, [loadStats]);

  const signOut = useCallback(async () => {
    await request('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }, [router]);

  const value = useMemo(
    () => (user ? { user, stats, tick, refresh, toast, signOut } : null),
    [user, stats, tick, refresh, toast, signOut],
  );

  if (fatal) {
    return (
      <div className="empty" role="alert" style={{ minHeight: '100dvh' }}>
        <strong>Can’t reach the server</strong>
        <span>{fatal}</span>
        <button className="btn" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (!value)
    return (
      <div className="login-page" role="status" aria-busy="true" aria-label="Loading">
        <div style={{ display: 'grid', justifyItems: 'center' }}>
          <span className="boot-spinner" aria-hidden="true" />
          <span className="boot-text">Loading your mailbox…</span>
        </div>
      </div>
    );
  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast${item.kind === 'error' ? ' toast--error' : ''}`}>
            <span>{item.message}</span>
            {item.action && (
              <button
                onClick={() => {
                  item.action!.run();
                  setToasts((list) => list.filter((entry) => entry.id !== item.id));
                }}
              >
                {item.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
