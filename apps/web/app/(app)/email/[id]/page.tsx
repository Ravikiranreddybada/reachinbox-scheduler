'use client';
import DOMPurify from 'dompurify';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowLeft, ChevronDown, FileText, RotateCw, Star, Trash2 } from 'lucide-react';
import { useApp } from '@/components/AppProvider';
import { Avatar } from '@/components/Avatar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useDismiss } from '@/components/useDismiss';
import { ApiError, attachmentUrl, request } from '@/lib/api';
import { formatBytes, fullDateTime, shortDate } from '@/lib/format';
import type { EmailDetail } from '@/lib/types';

export default function EmailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, toast, refresh } = useApp();
  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  useDismiss(detailsRef, details, () => setDetails(false));

  useEffect(() => {
    let cancelled = false;
    request(`/api/emails/${id}`)
      .then((data) => !cancelled && setEmail(data))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
        else
          setError(
            e instanceof ApiError && e.status === 404 ? 'This email no longer exists.' : e.message,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  const body = useMemo(
    () =>
      email
        ? DOMPurify.sanitize(email.body, {
            ALLOWED_TAGS: [
              'p',
              'div',
              'span',
              'br',
              'b',
              'strong',
              'i',
              'em',
              'u',
              's',
              'strike',
              'del',
              'font',
              'ul',
              'ol',
              'li',
              'blockquote',
              'a',
              'h1',
              'h2',
              'h3',
              'hr',
            ],
            ALLOWED_ATTR: ['href', 'target', 'rel', 'style', 'size'],
          })
        : '',
    [email],
  );

  const goBack = () => {
    if (history.length > 1) router.back();
    else
      router.push(email?.status === 'SENT' || email?.status === 'FAILED' ? '/sent' : '/scheduled');
  };

  async function patch(change: { starred?: boolean; archived?: boolean }, message?: string) {
    if (!email) return;
    setBusy(true);
    try {
      await request(`/api/emails/${email.id}`, { method: 'PATCH', body: JSON.stringify(change) });
      refresh();
      if (change.archived !== undefined) {
        toast(message ?? 'Archived.', 'info', {
          label: 'Undo',
          run: () =>
            void request(`/api/emails/${email.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ archived: false }),
            }).then(refresh),
        });
        goBack();
      } else
        setEmail({
          ...email,
          ...(change.starred !== undefined ? { starred: change.starred } : {}),
        });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!email) return;
    setBusy(true);
    try {
      await request(`/api/emails/${email.id}`, { method: 'DELETE' });
      refresh();
      toast(
        email.status === 'SCHEDULED' ? 'Scheduled email cancelled and deleted.' : 'Email deleted.',
      );
      router.replace(email.status === 'SENT' || email.status === 'FAILED' ? '/sent' : '/scheduled');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete this email.', 'error');
      setConfirmDelete(false);
      setBusy(false);
    }
  }

  async function retry() {
    if (!email) return;
    setBusy(true);
    try {
      await request(`/api/emails/${email.id}/retry`, { method: 'POST' });
      refresh();
      toast('Queued to send again.');
      router.replace('/scheduled');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not retry.', 'error');
      setBusy(false);
    }
  }

  const senderName = email?.sender.displayName || email?.sender.email.split('@')[0] || '';
  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn back" aria-label="Back" onClick={goBack}>
          <ArrowLeft size={26} strokeWidth={1.5} color="#17181a" />
        </button>
        <h1>{email ? email.subject : error ? 'Email unavailable' : 'Loading…'}</h1>
        {email && (
          <div className="actions">
            <button
              className={`icon-btn star${email.starred ? ' star--on' : ''}`}
              style={{ marginRight: 0 }}
              aria-label={email.starred ? 'Remove star' : 'Star'}
              aria-pressed={email.starred}
              disabled={busy}
              onClick={() => void patch({ starred: !email.starred })}
            >
              <Star size={22} strokeWidth={1.4} />
            </button>
            <button
              className="icon-btn"
              aria-label="Archive"
              disabled={busy}
              onClick={() => void patch({ archived: true }, 'Email archived.')}
            >
              <Archive size={22} strokeWidth={1.4} />
            </button>
            <button
              className="icon-btn"
              aria-label="Delete"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={22} strokeWidth={1.4} />
            </button>
            <span className="vbar" aria-hidden="true" />
            <Avatar name={user.name} src={user.avatarUrl} size={38} />
          </div>
        )}
      </header>

      {error && (
        <div className="empty" role="alert">
          <strong>{error}</strong>
          <button className="btn" onClick={() => router.push('/scheduled')}>
            Back to Scheduled
          </button>
        </div>
      )}

      {email && (
        <article className="detail">
          <div className="sender-row">
            <Avatar name={senderName} size={47} green />
            <div className="meta">
              <div className="name">
                <strong>{senderName}</strong> <span>&lt;{email.sender.email}&gt;</span>
              </div>
              <div className="to-wrap" ref={detailsRef}>
                <button
                  className="to-toggle"
                  aria-expanded={details}
                  onClick={() => setDetails((value) => !value)}
                >
                  to {email.recipient} <ChevronDown size={14} aria-hidden="true" />
                </button>
                {details && (
                  <dl className="to-pop">
                    <dt>from:</dt>
                    <dd>{email.sender.email}</dd>
                    <dt>to:</dt>
                    <dd>{email.recipient}</dd>
                    <dt>date:</dt>
                    <dd>{fullDateTime(email.sentAt ?? email.scheduledAt)}</dd>
                    <dt>subject:</dt>
                    <dd>{email.subject}</dd>
                    <dt>status:</dt>
                    <dd>{email.status.charAt(0) + email.status.slice(1).toLowerCase()}</dd>
                  </dl>
                )}
              </div>
            </div>
            <time className="date" dateTime={email.sentAt ?? email.scheduledAt}>
              {shortDate(email.sentAt ?? email.scheduledAt)}
            </time>
          </div>

          {(email.status === 'SCHEDULED' || email.status === 'PROCESSING') && (
            <div className="status-banner status-banner--scheduled" role="status">
              {email.status === 'PROCESSING'
                ? 'Sending now…'
                : `Scheduled for ${fullDateTime(email.scheduledAt)}`}
            </div>
          )}
          {email.status === 'FAILED' && (
            <div className="status-banner status-banner--failed" role="alert">
              <span>Delivery failed{email.errorMessage ? `: ${email.errorMessage}` : '.'}</span>
              <button className="btn" onClick={() => void retry()} disabled={busy}>
                <RotateCw size={15} aria-hidden="true" /> Retry
              </button>
            </div>
          )}

          <div className="email-body" dangerouslySetInnerHTML={{ __html: body }} />

          {email.attachments.length > 0 && (
            <div className="attachments">
              {email.attachments.map((file) => (
                <a
                  key={file.id}
                  className="att-card"
                  href={attachmentUrl(file.id, true)}
                  download={file.filename}
                >
                  <div className="thumb">
                    {file.contentType.startsWith('image/') &&
                    file.contentType !== 'image/svg+xml' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={attachmentUrl(file.id)} alt={file.filename} />
                    ) : (
                      <FileText size={40} strokeWidth={1.2} aria-hidden="true" />
                    )}
                  </div>
                  <div className="info">
                    <strong>{file.filename}</strong>
                    <span>{formatBytes(file.size)}</span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </article>
      )}

      {confirmDelete && email && (
        <ConfirmDialog
          title="Delete this email?"
          message={
            email.status === 'SCHEDULED'
              ? 'It has not been sent yet. Deleting cancels the scheduled send.'
              : 'It will be removed from your mailbox.'
          }
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
