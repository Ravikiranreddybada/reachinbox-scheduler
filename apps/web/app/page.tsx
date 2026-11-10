'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Entry point: OAuth callbacks land here with a message, then we route onward. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const authError = params.get('auth_error');
    if (authError) router.replace(`/login?auth_error=${encodeURIComponent(authError)}`);
    else router.replace(`/scheduled${location.search}`);
  }, [router]);
  return <div className="login-page" aria-busy="true" />;
}
