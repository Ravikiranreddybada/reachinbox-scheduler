'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Activity,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Command,
  FileUp,
  Inbox,
  LifeBuoy,
  LogOut,
  Mail,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';

type User = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  slackConnection?: { teamName?: string | null } | null;
};
type Email = {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: string;
  sentAt?: string | null;
  status: 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';
  errorMessage?: string | null;
};
type ActiveStatus = 'SCHEDULED' | 'SENT' | 'FAILED';
type SchedulePayload = {
  sender: string;
  senderName: string;
  recipients: string[];
  subject: string;
  body: string;
  scheduledAt: string;
  delayBetweenMs: number;
  hourlyLimit: number;
  idempotencyKey: string;
};
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (response.status === 401) throw new Error('Please sign in to continue.');
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
function parseLeadFile(text: string) {
  return [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])].map((x) =>
    x.toLowerCase(),
  );
}
export default function Home() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [active, setActive] = useState<ActiveStatus>('SCHEDULED'),
    [emails, setEmails] = useState<Email[]>([]),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [compose, setCompose] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [currentCursor, setCurrentCursor] = useState<string | null>(null),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]),
    [refreshKey, setRefreshKey] = useState(0),
    [systemHealth, setSystemHealth] = useState<
      'checking' | 'operational' | 'degraded' | 'unavailable'
    >('checking'),
    [totals, setTotals] = useState({
      scheduled: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      cancelled: 0,
    });
  const searchRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try {
      const me = await request('/auth/me');
      setUser(me.user);
      const status =
        active === 'SCHEDULED' ? 'SCHEDULED,PROCESSING' : active === 'SENT' ? 'SENT' : 'FAILED';
      const cursor = currentCursor ? `&cursor=${encodeURIComponent(currentCursor)}` : '';
      const [data, summary] = await Promise.all([
        request(`/api/emails?status=${status}&limit=50${cursor}`),
        request('/api/emails/stats'),
      ]);
      setEmails(data.items || []);
      setNextCursor(data.nextCursor || null);
      setTotals(summary);
      setError('');
    } catch (e) {
      if (e instanceof Error && e.message !== 'Please sign in to continue.') setError(e.message);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [active, currentCursor]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requestedStatus = params.get('status');
    if (requestedStatus === 'SENT' || requestedStatus === 'FAILED') setActive(requestedStatus);
    const requestedCursor = params.get('cursor');
    if (requestedCursor) {
      setCurrentCursor(requestedCursor);
      setCursorHistory([null]);
    }
    if (params.get('slack') === 'connected') {
      setNotice('Slack notifications are connected.');
      params.delete('slack');
      history.replaceState({}, '', `${location.pathname}?${params.toString()}`.replace(/\?$/, ''));
    }
    void fetch(`${API}/health`)
      .then(async (response) => {
        const result = await response.json();
        setSystemHealth(
          !response.ok ? 'unavailable' : result.status === 'ok' ? 'operational' : 'degraded',
        );
      })
      .catch(() => setSystemHealth('unavailable'));
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        if (search.trim()) {
          const statuses = active === 'SCHEDULED' ? 'SCHEDULED,PROCESSING' : active;
          void request(
            `/api/emails/search?q=${encodeURIComponent(search)}&status=${encodeURIComponent(statuses)}`,
            { signal: controller.signal },
          )
            .then((d) =>
              setEmails(
                (d.items || []).map((x: Email & { emailId?: string }) => ({
                  ...x,
                  id: x.id || x.emailId || '',
                })),
              ),
            )
            .catch((e) => {
              if (e.name !== 'AbortError') setError(e.message);
            });
          setNextCursor(null);
        } else void load();
      },
      search.trim() ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, active, load, refreshKey]);
  const stats = useMemo(
    () => ({
      scheduled: totals.scheduled + totals.processing,
      sent: totals.sent,
      failed: totals.failed,
    }),
    [totals],
  );
  function selectTab(status: ActiveStatus) {
    setActive(status);
    setSearch('');
    setCurrentCursor(null);
    setCursorHistory([]);
    const params = new URLSearchParams(location.search);
    params.set('status', status);
    params.delete('cursor');
    history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
  }
  function nextPage() {
    if (!nextCursor) return;
    setCursorHistory((history) => [...history, currentCursor]);
    setCurrentCursor(nextCursor);
    const params = new URLSearchParams(location.search);
    params.set('cursor', nextCursor);
    history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
  }
  function previousPage() {
    if (!cursorHistory.length) return;
    const history = [...cursorHistory];
    const previous = history.pop() ?? null;
    setCurrentCursor(previous);
    setCursorHistory(history);
    const params = new URLSearchParams(location.search);
    if (previous) params.set('cursor', previous);
    else params.delete('cursor');
    window.history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
  }
  async function logout() {
    await request('/auth/logout', { method: 'POST' });
    setUser(null);
    setEmails([]);
  }
  async function schedule(payload: SchedulePayload) {
    setBusy(true);
    try {
      await request('/api/emails', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setNotice(
        `${payload.recipients.length} ${payload.recipients.length === 1 ? 'email' : 'emails'} added to your schedule.`,
      );
      setCompose(false);
      selectTab('SCHEDULED');
      setSearch('');
      setRefreshKey((key) => key + 1);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not schedule emails. Please try again.';
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <main className="loading-screen">
        <div className="loader-mark">
          <Send size={21} />
        </div>
        <span>Preparing your workspace…</span>
      </main>
    );
  if (!user)
    return (
      <main className="login-shell">
        <div className="login-card">
          <div className="brand-lockup">
            <div className="brand-mark">
              <Send size={17} />
            </div>
            <span>reachinbox</span>
          </div>
          <div className="login-art">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="mail-illustration">
              <Mail size={54} />
              <span className="spark spark-a">✳</span>
              <span className="spark spark-b">✦</span>
            </div>
          </div>
          <div className="login-copy">
            <div className="eyebrow">
              <span className="live-dot" /> OUTBOX LABS · EMAIL OPERATIONS
            </div>
            <h1>
              Make every send
              <br />
              <em>feel intentional.</em>
            </h1>
            <p>A clear view of what’s queued, what’s moving, and what’s already landed.</p>
            <a className="google-button" href={`${API}/auth/google`}>
              <GoogleMark />
              Continue with Google
              <ArrowRight size={17} />
            </a>
            <div className="login-meta">
              <span>
                <ShieldCheck size={14} /> Secure Google sign in
              </span>
              <span>Built for thoughtful outreach</span>
            </div>
          </div>
          <div className="login-bottom">
            <span>© 2026 ReachInbox</span>
            <span>Powered by Outbox Labs</span>
          </div>
        </div>
        <div className="login-side">
          <div className="side-quote">
            <span className="quote-mark">“</span>
            <p>Reliability is a feature. Good systems make it feel effortless.</p>
            <div className="quote-rule" />
            <span className="quote-credit">A SMALL SLICE OF REACHINBOX</span>
          </div>
          <div className="side-foot">
            <span>QUEUE STATUS</span>
            <span className={`side-status ${systemHealth}`}>
              <i />
              {systemHealth === 'checking'
                ? 'Checking systems…'
                : systemHealth === 'operational'
                  ? 'All systems ready'
                  : systemHealth === 'degraded'
                    ? 'Search is degraded'
                    : 'Services unavailable'}
            </span>
          </div>
        </div>
      </main>
    );
  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <a className="brand-lockup" href="#main-content">
          <div className="brand-mark">
            <Send size={16} />
          </div>
          <span>reachinbox</span>
          <span className="brand-beta">LABS</span>
        </a>
        <button
          className="workspace-picker"
          onClick={() => setNotice('Outbox workspace is selected.')}
        >
          <div className="workspace-avatar">O</div>
          <div>
            <b>Outbox workspace</b>
            <small>Growth team</small>
          </div>
          <ChevronDown size={15} />
        </button>
        <div className="nav-section">
          <span className="nav-label">WORKSPACE</span>
          <button className="nav-item active">
            <Inbox size={17} />
            <span>Campaigns</span>
            <span className="nav-count">{stats.scheduled}</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setNotice('Sender settings are managed per account.')}
          >
            <Send size={17} />
            <span>Senders</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setNotice('Insights will appear as delivery data comes in.')}
          >
            <Activity size={17} />
            <span>Insights</span>
          </button>
        </div>
        <div className="sidebar-spacer" />
        <div className="sidebar-bottom">
          <div className="plan-card">
            <div className="plan-top">
              <span className="plan-icon">
                <Zap size={15} />
              </span>
              <span>DELIVERY GUARD</span>
              <span className="active-tag">ON</span>
            </div>
            <p>Smart pacing keeps your sending reputation healthy.</p>
            <button onClick={() => setNotice('Your send pacing is configured per campaign.')}>
              View settings <ArrowRight size={13} />
            </button>
          </div>
          <button className="nav-item" onClick={() => setNotice('Help center is coming soon.')}>
            <CircleHelp size={17} />
            <span>Help center</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setNotice('Workspace settings are managed by your administrator.')}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
          <div className="profile-card">
            <div className="avatar">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" width="32" height="32" />
              ) : (
                initials(user.name)
              )}
            </div>
            <div className="profile-copy">
              <b>{user.name}</b>
              <small>{user.email}</small>
            </div>
            <button
              className="icon-button profile-menu"
              onClick={() => void logout()}
              aria-label="Log out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <section className="main-area" id="main-content">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMobileNav(!mobileNav)}
            aria-label={mobileNav ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileNav}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="crumb-slash">/</span>
            <strong>Campaigns</strong>
          </div>
          <div className="top-actions">
            <div className={`system-health ${systemHealth}`}>
              <i />
              {systemHealth === 'checking'
                ? 'Checking systems…'
                : systemHealth === 'operational'
                  ? 'All systems operational'
                  : systemHealth === 'degraded'
                    ? 'Search degraded'
                    : 'Services unavailable'}
            </div>
            <button
              className="icon-button"
              aria-label="Notifications"
              onClick={() => setNotice('You’re all caught up.')}
            >
              <Bell size={18} />
              <span className="notification-dot" />
            </button>
            <span className="top-divider" />
            <button
              className="user-chip"
              onClick={() => setNotice(`${user.name} · ${user.email}`)}
              aria-label="Show account summary"
            >
              <div className="avatar small">
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" width="26" height="26" />
                ) : (
                  initials(user.name)
                )}
              </div>
              <span>{user.name.split(' ')[0]}</span>
              <ChevronDown size={14} />
            </button>
          </div>
        </header>
        <div className="content-wrap">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="live-dot" /> CAMPAIGN CONTROL
              </div>
              <h1>Your campaigns</h1>
              <p className="page-subtitle">
                A steady view of every message, from first draft to delivery.
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="secondary-button"
                onClick={async () => {
                  if (user.slackConnection) {
                    try {
                      await request('/auth/slack', { method: 'DELETE' });
                      setUser({ ...user, slackConnection: null });
                      setNotice('Slack notifications disconnected.');
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Could not disconnect Slack.');
                    }
                  } else window.location.href = `${API}/auth/slack`;
                }}
              >
                {user.slackConnection ? (
                  <>
                    <Check size={15} /> Disconnect Slack
                  </>
                ) : (
                  <>
                    <span className="slack-mark">✳</span> Connect Slack
                  </>
                )}
              </button>
              <button className="primary-button" onClick={() => setCompose(true)}>
                <Plus size={17} /> Compose campaign
              </button>
            </div>
          </div>
          <div className="metric-grid">
            <Metric
              label="In the queue"
              value={String(stats.scheduled)}
              change="Scheduled to send"
              icon={<Clock3 size={17} />}
              tone="teal"
            />
            <Metric
              label="Successfully sent"
              value={String(stats.sent)}
              change="Delivered by the scheduler"
              icon={<Check size={17} />}
              tone="blue"
            />
            <Metric
              label="Needs attention"
              value={String(stats.failed)}
              change="Failed deliveries"
              icon={<Activity size={17} />}
              tone="amber"
            />
            <div className="metric-aside">
              <div className="aside-badge">
                <Sparkles size={15} />
              </div>
              <div>
                <b>Thoughtful pacing.</b>
                <p>Messages stay in order and respect your sender limits.</p>
              </div>
            </div>
          </div>
          <section className="campaign-panel">
            <div className="panel-heading">
              <div>
                <h2>Message activity</h2>
                <p>Keep an eye on what’s moving through your workspace.</p>
              </div>
              <div className="panel-tools">
                <label className="search-box">
                  <Search size={16} />
                  <input
                    ref={searchRef}
                    aria-label="Search messages"
                    name="message-search"
                    autoComplete="off"
                    placeholder="Search messages…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <kbd>⌘ K</kbd>
                </label>
                <button className="filter-button" onClick={() => setRefreshKey((key) => key + 1)}>
                  <ArrowDownUp size={15} />
                  Refresh
                </button>
                <button
                  className="icon-button panel-more"
                  aria-label="More options"
                  onClick={() => setNotice('Your activity is up to date.')}
                >
                  <MoreHorizontal size={18} />
                </button>
              </div>
            </div>
            <div className="tabs" role="tablist" aria-label="Message status">
              <button
                className={active === 'SCHEDULED' ? 'tab selected' : 'tab'}
                onClick={() => selectTab('SCHEDULED')}
                role="tab"
                aria-selected={active === 'SCHEDULED'}
              >
                <Clock3 size={15} /> Scheduled <span className="tab-count">{stats.scheduled}</span>
              </button>
              <button
                className={active === 'SENT' ? 'tab selected' : 'tab'}
                onClick={() => selectTab('SENT')}
                role="tab"
                aria-selected={active === 'SENT'}
              >
                <Send size={15} /> Sent <span className="tab-count">{stats.sent}</span>
              </button>
              <button
                className={active === 'FAILED' ? 'tab selected' : 'tab'}
                onClick={() => selectTab('FAILED')}
                role="tab"
                aria-selected={active === 'FAILED'}
              >
                <Activity size={15} /> Needs Attention{' '}
                <span className="tab-count">{stats.failed}</span>
              </button>
            </div>
            {error && (
              <div className="inline-error" role="alert">
                <span>{error}</span>
                <button onClick={() => setError('')} aria-label="Dismiss error">
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>RECIPIENT</th>
                    <th>SUBJECT</th>
                    <th>{active === 'SENT' ? 'SENT AT' : 'SCHEDULED FOR'}</th>
                    <th>STATUS</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {emails.map((email) => (
                    <tr key={email.id}>
                      <td>
                        <div className="recipient-cell">
                          <span className="recipient-avatar">
                            {email.recipient.slice(0, 1).toUpperCase()}
                          </span>
                          <span>{email.recipient}</span>
                        </div>
                      </td>
                      <td>
                        <div className="subject-cell">
                          <b>{email.subject}</b>
                          <small>
                            {email.body.replace(/\s+/g, ' ').slice(0, 68)}
                            {email.body.length > 68 ? '…' : ''}
                          </small>
                        </div>
                      </td>
                      <td>
                        <span className="time-primary">
                          {formatDate(
                            active === 'SENT' && email.sentAt ? email.sentAt : email.scheduledAt,
                          )}
                        </span>
                        <small className="time-zone">
                          {new Intl.DateTimeFormat('en', { timeZoneName: 'short' })
                            .format(new Date(email.scheduledAt))
                            .split(' ')
                            .at(-1)}
                        </small>
                      </td>
                      <td>
                        <Status status={email.status} />
                      </td>
                      <td>
                        <button
                          className="row-more"
                          aria-label="More email options"
                          onClick={() =>
                            setNotice(email.errorMessage || 'Message details are up to date.')
                          }
                        >
                          <MoreHorizontal size={17} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {emails.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    {active === 'SENT' ? (
                      <Send size={21} />
                    ) : active === 'FAILED' ? (
                      <Activity size={21} />
                    ) : (
                      <Inbox size={21} />
                    )}
                  </div>
                  <h3>
                    {search
                      ? 'No matching messages'
                      : active === 'SENT'
                        ? 'Nothing sent just yet'
                        : active === 'FAILED'
                          ? 'No deliveries need attention'
                          : 'Your queue is clear'}
                  </h3>
                  <p>
                    {search
                      ? 'Try a different search.'
                      : active === 'SENT'
                        ? 'Messages you send will show up here with their delivery status.'
                        : active === 'FAILED'
                          ? 'Failed deliveries will appear here with a reason and next step.'
                          : 'When you schedule a campaign, each recipient will appear here.'}
                  </p>
                  {!search && active === 'SCHEDULED' && (
                    <button className="secondary-button" onClick={() => setCompose(true)}>
                      <Plus size={15} /> Compose a campaign
                    </button>
                  )}
                </div>
              ) : null}
            </div>
            <div className="table-footer">
              <span>
                Showing <b>{emails.length}</b>{' '}
                {active === 'SENT' ? 'sent' : active === 'FAILED' ? 'failed' : 'scheduled'} messages
              </span>
              <div className="pagination">
                <button
                  disabled={!cursorHistory.length || Boolean(search.trim())}
                  onClick={previousPage}
                  aria-label="Previous page"
                >
                  <ArrowLeft size={14} />
                </button>
                <span>
                  Page <b>{cursorHistory.length + 1}</b>
                </span>
                <button
                  disabled={!nextCursor || Boolean(search.trim())}
                  onClick={nextPage}
                  aria-label="Next page"
                >
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </section>
          <footer className="app-footer">
            <span>
              ReachInbox Scheduler <span className="footer-dot">·</span> A reliable way to stay in
              touch.
            </span>
            <span>Built with care at Outbox Labs</span>
          </footer>
        </div>
      </section>
      {compose && (
        <ComposeModal
          user={user}
          onClose={() => setCompose(false)}
          onSubmit={schedule}
          busy={busy}
        />
      )}
      {notice && (
        <div className="toast" role="status" aria-live="polite">
          <Check size={16} />
          {notice}
          <button onClick={() => setNotice('')} aria-label="Dismiss notification">
            <X size={14} />
          </button>
        </div>
      )}
      {mobileNav && (
        <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close menu" />
      )}
    </main>
  );
}
function Metric({
  label,
  value,
  change,
  icon,
  tone,
}: {
  label: string;
  value: string;
  change: string;
  icon: ReactNode;
  tone: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span>{label}</span>
        <span className={`metric-icon ${tone}`}>{icon}</span>
      </div>
      <strong>{value}</strong>
      <small>{change}</small>
      <div className={`metric-line ${tone}`} />
    </div>
  );
}
function Status({ status }: { status: Email['status'] }) {
  const map = {
    SCHEDULED: ['Scheduled', 'scheduled'],
    PROCESSING: ['Sending', 'sending'],
    SENT: ['Sent', 'sent'],
    FAILED: ['Failed', 'failed'],
    CANCELLED: ['Cancelled', 'cancelled'],
  } as const;
  const [label, style] = map[status];
  return (
    <span className={`status-pill ${style}`}>
      <i />
      {label}
    </span>
  );
}
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.9 6.1-15Z"
      />
      <path
        fill="#34A853"
        d="M24 44c5.5 0 10.2-1.8 13.6-4.9L31 34c-1.8 1.2-4.1 2-7 2-5.4 0-10-3.7-11.7-8.7H5.5v5.3A20.5 20.5 0 0 0 24 44Z"
      />
      <path
        fill="#FBBC05"
        d="M12.3 27.3a12.3 12.3 0 0 1 0-6.6v-5.3H5.5a20 20 0 0 0 0 17.2l6.8-5.3Z"
      />
      <path
        fill="#EA4335"
        d="M24 12.1c3 0 5.7 1 7.8 3.1l5.9-5.9A19.7 19.7 0 0 0 24 4 20.5 20.5 0 0 0 5.5 15.4l6.8 5.3C14 15.8 18.6 12.1 24 12.1Z"
      />
    </svg>
  );
}
function ComposeModal({
  user,
  onClose,
  onSubmit,
  busy,
}: {
  user: User;
  onClose: () => void;
  onSubmit: (payload: SchedulePayload) => Promise<string | null>;
  busy: boolean;
}) {
  const [emails, setEmails] = useState<string[]>([]),
    [idempotencyKey] = useState(() => crypto.randomUUID()),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState(''),
    [sender, setSender] = useState(user.email),
    [senderName, setSenderName] = useState(user.name),
    [start, setStart] = useState(() => {
      const d = new Date(Date.now() + 5 * 60000);
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      return d.toISOString().slice(0, 16);
    }),
    [delay, setDelay] = useState(2),
    [hourly, setHourly] = useState(200),
    [fileName, setFileName] = useState(''),
    [formError, setFormError] = useState('');
  const modalRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const dirty = Boolean(
    emails.length || subject || body || sender !== user.email || senderName !== user.name,
  );
  const closeRef = useRef<() => void>(() => undefined);
  closeRef.current = () => {
    if (!dirty || window.confirm('Discard this unscheduled campaign?')) onClose();
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    modal?.querySelector<HTMLElement>(focusableSelector)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !modal) return;
      const focusable = [...modal.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => !element.hasAttribute('disabled'),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);
  async function fileChanged(file?: File) {
    if (!file) return;
    const text = await file.text();
    const found = parseLeadFile(text);
    setEmails(found);
    setFileName(file.name);
    setFormError(found.length ? '' : 'No valid email addresses were found in this file.');
  }
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!emails.length)
      return setFormError('Add at least one valid recipient using a CSV or text file.');
    if (!subject.trim() || !body.trim())
      return setFormError('Add a subject and message before scheduling.');
    const time = new Date(start);
    if (Number.isNaN(time.getTime()) || time.getTime() < Date.now())
      return setFormError('Choose a start time in the future.');
    setFormError('');
    const submissionError = await onSubmit({
      sender,
      senderName,
      recipients: emails,
      subject,
      body,
      scheduledAt: time.toISOString(),
      delayBetweenMs: delay * 1000,
      hourlyLimit: hourly,
      idempotencyKey,
    });
    if (submissionError) setFormError(submissionError);
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <form
        className="compose-modal"
        onSubmit={handleSubmit}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-title"
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">
              <span className="live-dot" /> NEW CAMPAIGN
            </div>
            <h2 id="compose-title">Compose a campaign</h2>
            <p>Shape your message, then let the scheduler take it from here.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => closeRef.current()}
            aria-label="Close compose dialog"
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-content">
          <div className="form-two">
            <label className="field">
              From email
              <input
                type="email"
                name="sender-email"
                autoComplete="email"
                spellCheck={false}
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                required
              />
            </label>
            <label className="field">
              Sender name
              <input
                name="sender-name"
                autoComplete="name"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                required
              />
            </label>
          </div>
          <div className="field">
            <div className="field-heading">
              <span>Recipients</span>
              <span className="muted">CSV or plain text · up to 5,000</span>
            </div>
            <label className="upload-drop">
              <input
                type="file"
                name="recipients-file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={(e) => void fileChanged(e.target.files?.[0])}
              />
              <span className="upload-icon">
                <FileUp size={19} />
              </span>
              <span>
                <b>{fileName || 'Choose a leads file'}</b>
                <small>
                  {emails.length
                    ? `${emails.length.toLocaleString()} unique email addresses detected`
                    : 'Drop a .csv or .txt file here'}
                </small>
              </span>
              <span className="upload-action">Browse files</span>
            </label>
          </div>
          <label className="field">
            Subject
            <input
              name="subject"
              autoComplete="off"
              placeholder="e.g. A note worth opening…"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={998}
              required
            />
          </label>
          <label className="field">
            Message
            <textarea
              placeholder="Write a clear, personal message…"
              name="message-body"
              autoComplete="off"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              required
            />
            <small className="field-hint">Plain text email body</small>
          </label>
          <div className="field-heading schedule-heading">
            <span>Delivery controls</span>
            <span className="muted">Pacing is enforced across workers</span>
          </div>
          <div className="form-three">
            <label className="field">
              Start time
              <input
                type="datetime-local"
                name="scheduled-at"
                autoComplete="off"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              />
            </label>
            <label className="field">
              Delay between sends
              <div className="input-suffix">
                <input
                  type="number"
                  name="delay-seconds"
                  inputMode="numeric"
                  min="0"
                  max="3600"
                  value={delay}
                  onChange={(e) => setDelay(+e.target.value)}
                  required
                />
                <span>seconds</span>
              </div>
            </label>
            <label className="field">
              Hourly sender limit
              <div className="input-suffix">
                <input
                  type="number"
                  name="hourly-limit"
                  inputMode="numeric"
                  min="1"
                  max="10000"
                  value={hourly}
                  onChange={(e) => setHourly(+e.target.value)}
                  required
                />
                <span>/ hour</span>
              </div>
            </label>
          </div>
          {formError && (
            <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
              {formError}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span>
            <ShieldCheck size={15} /> Idempotent · persistent · paced
          </span>
          <div>
            <button type="button" className="secondary-button" onClick={() => closeRef.current()}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? (
                <>
                  <span className="button-spinner" /> Scheduling…
                </>
              ) : (
                <>
                  <Clock3 size={16} /> Schedule {emails.length ? `${emails.length} emails` : ''}
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
