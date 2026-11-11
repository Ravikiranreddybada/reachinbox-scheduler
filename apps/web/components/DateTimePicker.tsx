'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type Props = {
  /** Local value as YYYY-MM-DDTHH:mm, or empty. */
  value: string;
  /** Earliest allowed local value, same format. */
  min: string;
  onChange: (value: string) => void;
  onDone: () => void;
};

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const pad = (n: number) => String(n).padStart(2, '0');

export function DateTimePicker({ value, min, onChange, onDone }: Props) {
  const base = new Date(value || min);
  const [view, setView] = useState({ y: base.getFullYear(), m: base.getMonth() });

  const day = (value || min).slice(0, 10);
  const h24 = Number((value || min).slice(11, 13));
  const minute = Number((value || min).slice(14, 16));
  const pm = h24 >= 12;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const minDay = min.slice(0, 10);
  const past = value !== '' && value < min;
  const colsRef = useRef<HTMLDivElement>(null);

  // keep the chosen hour and minute visible in the scroll columns
  useEffect(() => {
    colsRef.current?.querySelectorAll<HTMLElement>('.dtp-col').forEach((col) => {
      const on = col.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (on) col.scrollTop = on.offsetTop - col.clientHeight / 2 + on.clientHeight / 2;
    });
  }, [value]);

  const first = new Date(view.y, view.m, 1).getDay();
  const count = new Date(view.y, view.m + 1, 0).getDate();
  const cells = [
    ...Array.from({ length: first }, () => 0),
    ...Array.from({ length: count }, (_, i) => i + 1),
  ];

  function emit(d: string, h: number, mi: number) {
    const next = `${d}T${pad(h)}:${pad(mi)}`;
    onChange(next);
  }
  const to24 = (h: number, isPm: boolean) => (h % 12) + (isPm ? 12 : 0);
  const shift = (delta: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  return (
    <div className="dtp" role="group" aria-label="Pick date and time">
      <div className="dtp-body">
        <div className="dtp-cal">
          <div className="dtp-head">
            <span>
              {new Date(view.y, view.m, 1).toLocaleString('en', { month: 'long', year: 'numeric' })}
            </span>
            <button type="button" aria-label="Previous month" onClick={() => shift(-1)}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" aria-label="Next month" onClick={() => shift(1)}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="dtp-grid">
            {DAYS.map((d, i) => (
              <span key={`${d}${i}`} className="dtp-dow">
                {d}
              </span>
            ))}
            {cells.map((d, i) => {
              if (!d) return <span key={`e${i}`} />;
              const key = `${view.y}-${pad(view.m + 1)}-${pad(d)}`;
              return (
                <button
                  key={key}
                  type="button"
                  className="dtp-day"
                  aria-pressed={value !== '' && key === day}
                  disabled={key < minDay}
                  onClick={() => emit(key, h24, minute)}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
        <div className="dtp-cols" ref={colsRef}>
          <div className="dtp-col" aria-label="Hour">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={value !== '' && h === h12}
                onClick={() => emit(day, to24(h, pm), minute)}
              >
                {pad(h)}
              </button>
            ))}
          </div>
          <div className="dtp-col" aria-label="Minute">
            {Array.from({ length: 60 }, (_, i) => i).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={value !== '' && m === minute}
                onClick={() => emit(day, h24, m)}
              >
                {pad(m)}
              </button>
            ))}
          </div>
          <div className="dtp-col dtp-ampm" aria-label="AM or PM">
            {['AM', 'PM'].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={value !== '' && (p === 'PM') === pm}
                onClick={() => emit(day, to24(h12, p === 'PM'), minute)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
      {past && (
        <p className="dtp-warn" role="alert">
          Pick a time in the future.
        </p>
      )}
      <div className="dtp-foot">
        <button type="button" className="dtp-clear" onClick={() => onChange('')}>
          Clear
        </button>
        <button type="button" className="btn" onClick={onDone} disabled={!value || past}>
          Done
        </button>
      </div>
    </div>
  );
}
