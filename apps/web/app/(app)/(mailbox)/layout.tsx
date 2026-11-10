'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Clock, Menu, Send } from 'lucide-react';
import { useApp } from '@/components/AppProvider';
import { Logo } from '@/components/Logo';
import { SlackCard } from '@/components/SlackCard';
import { UserMenu } from '@/components/UserMenu';

export default function MailboxLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { stats } = useApp();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const items = [
    {
      href: '/scheduled',
      label: 'Scheduled',
      count: stats.scheduled + stats.processing,
      Icon: Clock,
    },
    { href: '/sent', label: 'Sent', count: stats.sent + stats.failed, Icon: Send },
  ];
  return (
    <div className="shell">
      <div className="scrim" data-open={open} onClick={() => setOpen(false)} />
      <aside className="sidebar" data-open={open} aria-label="Mailbox">
        <Logo />
        <UserMenu />
        <Link href="/compose" className="compose-cta">
          Compose
        </Link>
        <div className="nav-label" id="core-label">
          Core
        </div>
        <nav aria-labelledby="core-label">
          {items.map(({ href, label, count, Icon }) => (
            <Link
              key={href}
              href={href}
              className="nav-item"
              aria-current={pathname.startsWith(href) ? 'page' : undefined}
            >
              <Icon size={19} strokeWidth={1.6} aria-hidden="true" />
              {label}
              <span className="count">{count.toLocaleString()}</span>
            </Link>
          ))}
        </nav>
        <SlackCard />
      </aside>
      <main className="main">
        <div className="mobile-bar">
          <button className="icon-btn" aria-label="Open menu" onClick={() => setOpen(true)}>
            <Menu size={22} />
          </button>
          <Logo />
        </div>
        {children}
      </main>
    </div>
  );
}
