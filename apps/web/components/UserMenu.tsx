'use client';
import { useRef, useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import { Avatar } from './Avatar';
import { useApp } from './AppProvider';
import { useDismiss } from './useDismiss';

/** Account card from the design: avatar, name, email, chevron menu. */
export function UserMenu() {
  const { user, signOut } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div className="account" ref={ref}>
      <button
        className="account-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar name={user.name} src={user.avatarUrl} size={38} />
        <span className="who">
          <strong>{user.name}</strong>
          <span>{user.email}</span>
        </span>
        <ChevronDown
          size={18}
          color="#6b706c"
          aria-hidden="true"
          className={open ? 'flip' : undefined}
        />
      </button>
      {open && (
        <div className="menu menu--down" role="menu">
          <div className="menu-label">Signed in as</div>
          <div className="menu-static">{user.email}</div>
          <button role="menuitem" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden="true" /> Log out
          </button>
        </div>
      )}
    </div>
  );
}
