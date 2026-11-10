'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Filter, Inbox, RotateCw, Search, Star } from 'lucide-react';
import { ApiError, request } from '@/lib/api';
import { pillTime, shortDate } from '@/lib/format';
import type { Email, Mailbox } from '@/lib/types';
import { useApp } from './AppProvider';
import { Highlighted } from './Highlighted';
import { useDismiss } from './useDismiss';

type SentFilter = 'all' | 'sent' | 'failed';

export function MailList({ mailbox }: { mailbox: Mailbox }) {
  const router = useRouter();
  const params = useSearchParams();
  const { tick, refresh, toast } = useApp();
  const [items, setItems] = useState<Email[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [sentFilter, setSentFilter] = useState<SentFilter>('all');
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  useDismiss(filterRef, filterOpen, () => setFilterOpen(false));

  // OAuth return messages (e.g. ?slack=connected) are shown once, then removed.
  useEffect(() => {
    const slack = params.get('slack');
    const slackError = params.get('slack_error');
    if (slack === 'connected') toast('Slack notifications are connected.');
    if (slackError) toast(slackError, 'error');
    if (slack || slackError) router.replace(`/${mailbox}`);
  }, [params, router, mailbox, toast]);

  const statuses = useMemo(() => {
    if (mailbox === 'scheduled') return 'SCHEDULED,PROCESSING';
    return sentFilter === 'sent' ? 'SENT' : sentFilter === 'failed' ? 'FAILED' : 'SENT,FAILED';
  }, [mailbox, sentFilter]);

  const load = useCallback(
    async (opts: { silent?: boolean; after?: string | null; signal?: AbortSignal } = {}) => {
      if (!opts.silent && !opts.after) setLoading(true);
      try {
        if (query.trim()) {
          const data = await request(
            `/api/emails/search?q=${encodeURIComponent(query.trim())}&status=${encodeURIComponent(statuses)}`,
            { signal: opts.signal },
          );
          setItems(data.items ?? []);
          setCursor(null);
        } else {
          const after = opts.after ? `&cursor=${encodeURIComponent(opts.after)}` : '';
          const star = starredOnly ? '&starred=true' : '';
          const data = await request(
            `/api/emails?status=${encodeURIComponent(statuses)}&limit=50${after}${star}`,
            { signal: opts.signal },
          );
          setItems((current) => (opts.after ? [...current, ...data.items] : data.items));
          setCursor(data.nextCursor ?? null);
        }
        setError('');
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (e instanceof ApiError && e.status === 401) {
          router.replace('/login');
          return;
        }
        setError(e instanceof Error ? e.message : 'Could not load your emails.');
      } finally {
        setLoading(false);
      }
    },
    [query, statuses, starredOnly, router],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => void load({ signal: controller.signal }),
      query.trim() ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, query]);

  // Live update from the server: silent re-fetch of the first page.
  const firstTick = useRef(tick);
  useEffect(() => {
    if (tick === firstTick.current || query.trim()) return;
    void load({ silent: true });
  }, [tick, load, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function toggleStar(email: Email) {
    const next = !email.starred;
    setItems((list) =>
      list.map((item) => (item.id === email.id ? { ...item, starred: next } : item)),
    );
    try {
      await request(`/api/emails/${email.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ starred: next }),
      });
      if (starredOnly && !next) setItems((list) => list.filter((item) => item.id !== email.id));
    } catch (e) {
      setItems((list) =>
        list.map((item) => (item.id === email.id ? { ...item, starred: !next } : item)),
      );
      toast(e instanceof Error ? e.message : 'Could not update the star.', 'error');
    }
  }

  async function onRefresh() {
    setReloading(true);
    refresh();
    await load({ silent: true });
    setReloading(false);
  }

  const visible = query.trim() && starredOnly ? items.filter((item) => item.starred) : items;
  const filtersActive = starredOnly || (mailbox === 'sent' && sentFilter !== 'all');
  const heading = mailbox === 'scheduled' ? 'Scheduled' : 'Sent';

  return (
    <section aria-label={`${heading} emails`}>
      <div className="list-toolbar">
        <label className="search">
          <Search size={19} strokeWidth={1.6} aria-hidden="true" />
          <span className="sr-only">Search {heading.toLowerCase()} emails</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {!query && <kbd aria-hidden="true">⌘K</kbd>}
        </label>
        <div className="filter-wrap" ref={filterRef}>
          <button
            className={`icon-btn${filtersActive ? ' icon-btn--active' : ''}`}
            aria-label="Filter"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((value) => !value)}
          >
            <Filter size={20} strokeWidth={1.5} />
          </button>
          {filterOpen && (
            <div className="menu menu--filter" role="menu">
              <button
                role="menuitemcheckbox"
                aria-checked={starredOnly}
                onClick={() => setStarredOnly((value) => !value)}
              >
                <Star size={16} aria-hidden="true" /> Starred only
              </button>
              {mailbox === 'sent' && (
                <>
                  <div className="menu-label">Status</div>
                  {(['all', 'sent', 'failed'] as const).map((value) => (
                    <button
                      key={value}
                      role="menuitemradio"
                      aria-checked={sentFilter === value}
                      onClick={() => setSentFilter(value)}
                    >
                      {value === 'all' ? 'All' : value === 'sent' ? 'Sent' : 'Failed'}
                    </button>
                  ))}
                </>
              )}
              {filtersActive && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setStarredOnly(false);
                    setSentFilter('all');
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
        <button
          className="icon-btn"
          aria-label="Refresh"
          onClick={() => void onRefresh()}
          disabled={reloading}
        >
          <RotateCw size={20} strokeWidth={1.5} className={reloading ? 'spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="form-error list-note" role="alert">
          {error}{' '}
          <button style={{ textDecoration: 'underline' }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div aria-busy="true" aria-label="Loading emails">
          {[0, 1, 2].map((key) => (
            <div className="skeleton-row" key={key} />
          ))}
        </div>
      ) : visible.length === 0 && !error ? (
        <div className="empty">
          <span className="empty-art">
            <Inbox size={32} strokeWidth={1.4} aria-hidden="true" />
          </span>
          <strong>
            {query.trim()
              ? 'No matches'
              : mailbox === 'scheduled'
                ? 'Nothing scheduled'
                : 'Nothing sent yet'}
          </strong>
          <span>
            {query.trim()
              ? 'Try a different search.'
              : mailbox === 'scheduled'
                ? 'Compose an email to schedule it.'
                : 'Sent emails will show up here.'}
          </span>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {visible.map((email, index) => (
            <li
              key={email.id}
              className="mail-row"
              style={{ ['--i' as string]: Math.min(index, 12) }}
              onClick={() => router.push(`/email/${email.id}`)}
            >
              <span className="to">To: {email.recipient}</span>
              <div className="summary">
                {email.status === 'SENT' ? (
                  <span className="pill">Sent</span>
                ) : email.status === 'FAILED' ? (
                  <span className="pill pill--failed">Failed</span>
                ) : email.status === 'PROCESSING' ? (
                  <span className="pill pill--processing">
                    <span className="dot" aria-hidden="true" />
                    Sending
                  </span>
                ) : (
                  <span
                    className="pill pill--scheduled"
                    title={new Date(email.scheduledAt).toLocaleString()}
                  >
                    <Clock size={14} aria-hidden="true" />
                    {pillTime(email.scheduledAt)}
                  </span>
                )}
                <span className="text">
                  <a
                    href={`/email/${email.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      router.push(`/email/${email.id}`);
                    }}
                  >
                    <strong>{email.subject}</strong>
                  </a>
                  {email.preview && (
                    <span className="preview">
                      {' '}
                      - <Highlighted text={email.preview} />
                    </span>
                  )}
                </span>
                {email.status === 'SENT' || email.status === 'FAILED' ? (
                  <time className="when" dateTime={email.sentAt ?? email.scheduledAt}>
                    {shortDate(email.sentAt ?? email.scheduledAt)}
                  </time>
                ) : null}
              </div>
              <span className="star-cell" onClick={(event) => event.stopPropagation()}>
                <button
                  className={`icon-btn star${email.starred ? ' star--on' : ''}`}
                  aria-label={email.starred ? 'Remove star' : 'Star'}
                  aria-pressed={email.starred}
                  onClick={() => void toggleStar(email)}
                >
                  <Star size={20} strokeWidth={1.4} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {cursor && !loading && (
        <button className="btn load-more" onClick={() => void load({ after: cursor })}>
          Load more
        </button>
      )}
    </section>
  );
}
