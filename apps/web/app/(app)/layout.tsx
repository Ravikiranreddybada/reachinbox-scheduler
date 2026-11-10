import { AppProvider } from '@/components/AppProvider';

export default function SignedInLayout({ children }: { children: React.ReactNode }) {
  return <AppProvider>{children}</AppProvider>;
}
