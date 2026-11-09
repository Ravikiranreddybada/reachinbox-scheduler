import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'ReachInbox · Campaign scheduler',
  description: 'Schedule, monitor, and deliver outbound campaigns with confidence.',
};
export const viewport: Viewport = {
  themeColor: '#f5f8f7',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
