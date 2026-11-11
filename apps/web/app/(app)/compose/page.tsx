'use client';
import { useRouter } from 'next/navigation';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  FileText,
  Paperclip,
  Upload,
  X,
} from 'lucide-react';
import { DateTimePicker } from '@/components/DateTimePicker';
import { useApp } from '@/components/AppProvider';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { type EditorHandle, RichTextEditor } from '@/components/RichTextEditor';
import { useDismiss } from '@/components/useDismiss';
import { ApiError, request, uploadAttachment } from '@/lib/api';
import { EMAIL_RE, formatBytes, parseLeadFile } from '@/lib/format';
import type { SchedulePayload } from '@/lib/types';

type Att = {
  key: string;
  name: string;
  size: number;
  type: string;
  preview?: string;
  id?: string;
  error?: string;
};
const MAX_FILES = 10;
const MAX_RECIPIENTS = 5000; // keep equal to the API cap in routes/emails.ts
const VISIBLE_CHIPS = 3;

const toLocalInput = (d: Date) => {
  const copy = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return copy.toISOString().slice(0, 16);
};
function tomorrowAt(hour?: number, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (hour !== undefined) d.setHours(hour, minute, 0, 0);
  else d.setSeconds(0, 0);
  return d;
}
const QUICK = [
  { label: 'Tomorrow', at: () => tomorrowAt() },
  { label: 'Tomorrow, 10:00 AM', at: () => tomorrowAt(10) },
  { label: 'Tomorrow, 11:00 AM', at: () => tomorrowAt(11) },
  { label: 'Tomorrow, 3:00 PM', at: () => tomorrowAt(15) },
];
const scheduleLabel = (d: Date) =>
  new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);

export default function ComposePage() {
  const router = useRouter();
  const { user, toast, refresh } = useApp();
  const [senders, setSenders] = useState<string[]>([user.email]);
  const [from, setFrom] = useState(user.email);
  const [fromOpen, setFromOpen] = useState(false);
  const [addingSender, setAddingSender] = useState(false);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [listInfo, setListInfo] = useState<{ name: string; found: number; added: number } | null>(
    null,
  );
  const [subject, setSubject] = useState('');
  const [delay, setDelay] = useState('');
  const [hourly, setHourly] = useState('');
  const [html, setHtml] = useState('');
  const [attachments, setAttachments] = useState<Att[]>([]);
  const [scheduledFor, setScheduledFor] = useState<Date | null>(null);
  const [popover, setPopover] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const fromRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState(false);
  const listRef = useRef<HTMLInputElement>(null);
  const editor = useRef<EditorHandle>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const keyRef = useRef({ sig: '', key: crypto.randomUUID() });
  useDismiss(fromRef, fromOpen, () => setFromOpen(false));
  useDismiss(popRef, popover, () => setPopover(false));

  useEffect(() => {
    request('/api/senders')
      .then((data: { items: { email: string }[] }) =>
        setSenders((current) => [...new Set([...current, ...data.items.map((s) => s.email)])]),
      )
      .catch(() => undefined);
  }, []);

  const uploading = attachments.some((a) => !a.id && !a.error);
  const dirty = Boolean(recipients.length || draft || subject || html || attachments.length);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const onEditor = useCallback((value: string) => setHtml(value), []);

  /* ----- recipients ----- */
  function commit(raw: string) {
    const parts = raw
      .split(/[\s,;]+/)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return true;
    const bad = parts.filter((p) => !EMAIL_RE.test(p));
    const good = parts.filter((p) => EMAIL_RE.test(p));
    if (good.length) setRecipients((list) => [...new Set([...list, ...good])]);
    if (bad.length) {
      setError(`"${bad[0]}" is not a valid email address.`);
      setDraft(bad.join(' '));
      return false;
    }
    setError('');
    setDraft('');
    return true;
  }
  function onToKey(event: KeyboardEvent<HTMLInputElement>) {
    if (['Enter', ',', ';', ' ', 'Tab'].includes(event.key) && draft.trim()) {
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && !draft && recipients.length) {
      setRecipients((list) => list.slice(0, -1));
    }
  }
  function onToPaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text');
    if (/[\s,;]/.test(text.trim())) {
      event.preventDefault();
      commit(text);
    }
  }
  async function onList(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const found = parseLeadFile(await file.text());
    if (!found.length) {
      setError(`No email addresses found in ${file.name}.`);
      return;
    }
    const before = new Set(recipients);
    const merged = [...new Set([...recipients, ...found])];
    if (merged.length > MAX_RECIPIENTS) {
      setError(
        `${file.name} gives ${merged.length.toLocaleString()} recipients. The limit is ${MAX_RECIPIENTS.toLocaleString()} per send. Split the list.`,
      );
      return;
    }
    setRecipients(merged);
    setListInfo({
      name: file.name,
      found: found.length,
      added: found.filter((address) => !before.has(address)).length,
    });
    setError('');
  }

  /* ----- attachments ----- */
  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_FILES - attachments.length;
    const chosen = [...files].slice(0, Math.max(room, 0));
    if (files.length > chosen.length) setError(`You can attach up to ${MAX_FILES} files.`);
    for (const file of chosen) {
      const key = crypto.randomUUID();
      const preview =
        file.type.startsWith('image/') && file.type !== 'image/svg+xml'
          ? URL.createObjectURL(file)
          : undefined;
      const entry: Att = { key, name: file.name, size: file.size, type: file.type, preview };
      if (file.size > 5 * 1024 * 1024) {
        setAttachments((list) => [...list, { ...entry, error: 'Larger than 5 MB' }]);
        continue;
      }
      setAttachments((list) => [...list, entry]);
      uploadAttachment(file)
        .then((saved) =>
          setAttachments((list) => list.map((a) => (a.key === key ? { ...a, id: saved.id } : a))),
        )
        .catch((e) =>
          setAttachments((list) =>
            list.map((a) => (a.key === key ? { ...a, error: e.message } : a)),
          ),
        );
    }
    if (fileRef.current) fileRef.current.value = '';
  }
  function removeAttachment(att: Att) {
    setAttachments((list) => list.filter((a) => a.key !== att.key));
    if (att.preview) URL.revokeObjectURL(att.preview);
    if (att.id)
      void request(`/api/attachments/${att.id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  /* ----- schedule popover ----- */
  function openPopover() {
    setPending(scheduledFor ? toLocalInput(scheduledFor) : '');
    setPanel(false);
    setPopover((open) => !open);
  }
  function applyPending() {
    const date = new Date(pending);
    if (!pending || Number.isNaN(date.getTime())) return;
    if (date.getTime() < Date.now()) {
      toast('Pick a time in the future.', 'error');
      return;
    }
    setScheduledFor(date);
    setPopover(false);
  }

  /* ----- send ----- */
  const scheduledLabel = useMemo(
    () => (scheduledFor ? scheduleLabel(scheduledFor) : ''),
    [scheduledFor],
  );
  async function send() {
    setError('');
    const pendingAddress = draft.trim();
    let all = recipients;
    if (pendingAddress) {
      if (!commit(pendingAddress)) return;
      all = [
        ...new Set([...recipients, ...pendingAddress.split(/[\s,;]+/).map((p) => p.toLowerCase())]),
      ];
    }
    if (!all.length) return setError('Add at least one recipient.');
    if (all.length > MAX_RECIPIENTS)
      return setError(`Limit is ${MAX_RECIPIENTS.toLocaleString()} recipients per send.`);
    if (!subject.trim()) return setError('Add a subject.');
    if (!html) return setError('Write a message before sending.');
    if (uploading) return setError('Wait for attachments to finish uploading.');
    if (attachments.some((a) => a.error))
      return setError('Remove the attachment that failed to upload.');
    const delaySeconds = delay === '' ? 0 : Number(delay);
    const hourlyLimit = hourly === '' ? undefined : Number(hourly);
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600)
      return setError('Delay must be between 0 and 3600 seconds.');
    if (
      hourlyLimit !== undefined &&
      (!Number.isInteger(hourlyLimit) || hourlyLimit < 1 || hourlyLimit > 10000)
    )
      return setError('Hourly limit must be a whole number from 1 to 10,000.');
    if (scheduledFor && scheduledFor.getTime() < Date.now())
      return setError('The scheduled time has passed. Pick a new one.');

    const payload: Omit<SchedulePayload, 'idempotencyKey'> = {
      sender: from,
      senderName: from === user.email ? user.name : from.split('@')[0]!,
      recipients: all,
      subject: subject.trim(),
      body: html,
      // "Send" means now; the API accepts up to a minute of clock skew.
      scheduledAt: (scheduledFor ?? new Date()).toISOString(),
      delayBetweenMs: Math.round(delaySeconds * 1000),
      hourlyLimit,
      attachmentIds: attachments.flatMap((a) => (a.id ? [a.id] : [])),
    };
    // One key per distinct payload: retrying the same request stays idempotent.
    const sig = JSON.stringify({ ...payload, scheduledAt: scheduledFor?.toISOString() ?? 'now' });
    if (keyRef.current.sig !== sig) keyRef.current = { sig, key: crypto.randomUUID() };

    setBusy(true);
    try {
      const result = await request('/api/emails', {
        method: 'POST',
        body: JSON.stringify({ ...payload, idempotencyKey: keyRef.current.key }),
      });
      refresh();
      toast(
        scheduledFor
          ? `Scheduled ${result.accepted.toLocaleString()} email${result.accepted === 1 ? '' : 's'} for ${scheduledLabel}.`
          : `Sending ${result.accepted.toLocaleString()} email${result.accepted === 1 ? '' : 's'}.`,
      );
      router.replace('/scheduled');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setError(e instanceof Error ? e.message : 'Could not send. Try again.');
      setBusy(false);
    }
  }

  function leave() {
    if (dirty) setConfirmLeave(true);
    else router.back();
  }

  const shown = expanded ? recipients : recipients.slice(0, VISIBLE_CHIPS);
  const hidden = recipients.length - shown.length;

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn back" aria-label="Back" onClick={leave}>
          <ArrowLeft size={26} strokeWidth={1.5} color="#17181a" />
        </button>
        <h1>Compose New Email</h1>
        <div className="actions">
          {scheduledFor && (
            <span className="schedule-note" title="Scheduled send time">
              {scheduledLabel}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void addFiles(e.target.files)}
          />
          <button
            className={`icon-btn${attachments.length ? ' icon-btn--active' : ''}`}
            aria-label={`Attach files${attachments.length ? ` (${attachments.length})` : ''}`}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={22} strokeWidth={1.5} />
            {attachments.length > 0 && <span className="badge">{attachments.length}</span>}
          </button>
          <button
            className={`icon-btn${scheduledFor || popover ? ' icon-btn--active' : ''}`}
            aria-label="Send later options"
            aria-haspopup="dialog"
            aria-expanded={popover}
            // Keeps the outside-click closer from re-opening the popover on this toggle.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={openPopover}
          >
            <Clock size={22} strokeWidth={1.5} />
          </button>
          <button className="btn" onClick={() => void send()} disabled={busy || uploading}>
            {busy ? 'Sending…' : scheduledFor ? 'Send Later' : 'Send'}
          </button>
        </div>
      </header>

      {popover && (
        <div className="popover" role="dialog" aria-label="Send later" ref={popRef}>
          <h2>Send Later</h2>
          <div className="pick-field">
            <button
              type="button"
              className="pick-btn"
              onClick={() => {
                if (!panel && !pending) setPending(toLocalInput(new Date()));
                setPanel((o) => !o);
              }}
              aria-expanded={panel}
              style={{ color: pending ? 'var(--ink)' : 'var(--muted)' }}
            >
              {pending ? scheduleLabel(new Date(pending)) : 'Pick date & time'}
              <Calendar size={18} strokeWidth={1.5} aria-hidden="true" />
            </button>
            {panel && (
              <DateTimePicker
                value={pending}
                min={toLocalInput(new Date())}
                onChange={setPending}
                onDone={applyPending}
              />
            )}
          </div>
          {QUICK.map((option) => (
            <button
              key={option.label}
              type="button"
              className="quick"
              aria-pressed={pending === toLocalInput(option.at())}
              onClick={() => setPending(toLocalInput(option.at()))}
            >
              {option.label}
            </button>
          ))}
          <div className="foot">
            {scheduledFor && (
              <button
                className="clear"
                onClick={() => {
                  setScheduledFor(null);
                  setPopover(false);
                }}
              >
                Send now instead
              </button>
            )}
            <button className="btn btn--ghost" onClick={() => setPopover(false)}>
              Cancel
            </button>
            <button className="btn" onClick={applyPending} disabled={!pending}>
              Done
            </button>
          </div>
        </div>
      )}

      <form className="compose" onSubmit={(e) => e.preventDefault()} noValidate>
        {error && (
          <p className="form-error" role="alert" style={{ marginLeft: 0 }}>
            {error}
          </p>
        )}
        <div className="row">
          <span className="label">From</span>
          <div className="from-wrap" ref={fromRef}>
            <button
              type="button"
              className="from-btn"
              aria-haspopup="listbox"
              aria-expanded={fromOpen}
              onClick={() => setFromOpen((o) => !o)}
            >
              {from}
              <ChevronDown size={16} color="#6b706c" aria-hidden="true" />
            </button>
            {fromOpen && (
              <div className="menu menu--from" role="listbox">
                {senders.map((address) => (
                  <button
                    key={address}
                    role="option"
                    aria-selected={address === from}
                    aria-checked={address === from}
                    onClick={() => {
                      setFrom(address);
                      setFromOpen(false);
                    }}
                  >
                    {address}
                  </button>
                ))}
                <button
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    setFromOpen(false);
                    setAddingSender(true);
                  }}
                >
                  + Use another address…
                </button>
              </div>
            )}
          </div>
          {addingSender && (
            <input
              autoFocus
              className="field-input"
              style={{ margin: 0, height: 45, maxWidth: 300, fontSize: 16 }}
              type="email"
              placeholder="name@yourdomain.com"
              aria-label="Another sender address"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setAddingSender(false);
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const value = e.currentTarget.value.trim().toLowerCase();
                if (!EMAIL_RE.test(value)) return setError('Enter a valid sender address.');
                setSenders((list) => [...new Set([...list, value])]);
                setFrom(value);
                setAddingSender(false);
                setError('');
              }}
              onBlur={() => setAddingSender(false)}
            />
          )}
        </div>

        <div className="row">
          <label className="label" htmlFor="to" style={{ width: 52 }}>
            To
          </label>
          <div className="underline-field" onClick={() => toInput.current?.focus()}>
            {shown.map((address) => (
              <span className="chip" key={address}>
                {address}
                <button
                  type="button"
                  aria-label={`Remove ${address}`}
                  onClick={() => setRecipients((l) => l.filter((x) => x !== address))}
                >
                  <X size={13} />
                </button>
              </span>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                className="chip chip--more"
                aria-label={`Show ${hidden} more recipients`}
                onClick={() => setExpanded(true)}
              >
                +{hidden}
              </button>
            )}
            {expanded && recipients.length > VISIBLE_CHIPS && (
              <button type="button" className="chip chip--more" onClick={() => setExpanded(false)}>
                Show less
              </button>
            )}
            <input
              id="to"
              ref={toInput}
              type="text"
              inputMode="email"
              autoComplete="off"
              placeholder={recipients.length ? '' : 'recipient@example.com'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onToKey}
              onPaste={onToPaste}
              onBlur={() => draft.trim() && commit(draft)}
            />
            <input
              ref={listRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              hidden
              onChange={(e) => {
                void onList(e.target.files);
                e.target.value = '';
              }}
            />
            <button type="button" className="link-btn" onClick={() => listRef.current?.click()}>
              <Upload size={18} strokeWidth={1.6} aria-hidden="true" /> Upload List
            </button>
          </div>
        </div>
        {listInfo && (
          <p className="list-info" role="status">
            <Check size={16} aria-hidden="true" />
            <span>
              <strong>{listInfo.found.toLocaleString()}</strong> address
              {listInfo.found === 1 ? '' : 'es'} detected in {listInfo.name}
              {listInfo.added < listInfo.found
                ? ` (${(listInfo.found - listInfo.added).toLocaleString()} already added)`
                : ''}
            </span>
            <button type="button" aria-label="Dismiss" onClick={() => setListInfo(null)}>
              <X size={14} />
            </button>
          </p>
        )}
        {recipients.length > 0 && (
          <p className="hint" style={{ margin: '-4px 0 4px 66px' }}>
            {recipients.length.toLocaleString()} recipient{recipients.length === 1 ? '' : 's'}
          </p>
        )}

        <div className="row">
          <label className="label" htmlFor="subject">
            Subject
          </label>
          <div className="underline-field">
            <input
              id="subject"
              type="text"
              placeholder="Subject"
              maxLength={998}
              value={subject}
              onChange={(e) => setSubject(e.target.value.replace(/[\r\n]/g, ' '))}
            />
          </div>
        </div>

        <div className="row" style={{ gap: 18 }}>
          <label className="small-field">
            Delay between 2 emails
            <input
              inputMode="numeric"
              placeholder="00"
              value={delay}
              aria-describedby="delay-hint"
              onChange={(e) => setDelay(e.target.value.replace(/\D/g, '').slice(0, 4))}
            />
          </label>
          <label className="small-field">
            Hourly Limit
            <input
              inputMode="numeric"
              placeholder="00"
              value={hourly}
              onChange={(e) => setHourly(e.target.value.replace(/\D/g, '').slice(0, 5))}
            />
          </label>
          <span className="hint" id="delay-hint">
            Delay is in seconds. Leave blank for no extra spacing.
          </span>
        </div>

        <RichTextEditor editorRef={editor} onChange={onEditor} />

        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((att) => (
              <div
                className={`att-card${!att.id && !att.error ? ' att-card--busy' : ''}`}
                key={att.key}
              >
                <div className="thumb">
                  {att.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={att.preview} alt={att.name} />
                  ) : (
                    <FileText size={40} strokeWidth={1.2} aria-hidden="true" />
                  )}
                </div>
                <div className="info">
                  <strong>{att.name}</strong>
                  <span style={att.error ? { color: 'var(--red-ink)' } : undefined}>
                    {att.error ?? (att.id ? formatBytes(att.size) : 'Uploading…')}
                  </span>
                </div>
                <button
                  type="button"
                  className="att-remove"
                  aria-label={`Remove ${att.name}`}
                  onClick={() => removeAttachment(att)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </form>

      {confirmLeave && (
        <ConfirmDialog
          title="Discard this email?"
          message="Your draft has not been sent or scheduled. Leaving will delete it."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          danger
          onConfirm={() => {
            attachments.forEach(
              (a) =>
                a.id &&
                void request(`/api/attachments/${a.id}`, { method: 'DELETE' }).catch(
                  () => undefined,
                ),
            );
            router.back();
          }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
    </div>
  );
}
