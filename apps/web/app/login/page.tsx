'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { GoogleMark } from '@/components/GoogleMark';
import { API, request } from '@/lib/api';
import { EMAIL_RE } from '@/lib/format';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(params.get('auth_error') ?? '');
  const [busy, setBusy] = useState(false);

  // Already signed in? Skip the form.
  useEffect(() => {
    request('/auth/me')
      .then(() => router.replace('/scheduled'))
      .catch(() => undefined);
  }, [router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email address.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    setBusy(true);
    try {
      await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      router.replace('/scheduled');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit} noValidate>
        <h1>Login</h1>
        <a className="google-btn" href={`${API}/auth/google`}>
          <GoogleMark />
          Login with Google
        </a>
        <div className="divider">or sign up through email</div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <label className="sr-only" htmlFor="email">
          Email ID
        </label>
        <input
          id="email"
          className="field-input"
          type="email"
          autoComplete="email"
          placeholder="Email ID"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(error) && !EMAIL_RE.test(email.trim())}
        />
        <label className="sr-only" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="field-input"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn btn--solid" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Login'}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
