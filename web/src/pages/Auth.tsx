import { useState, type FormEvent } from 'react';
import { api, ApiError, setCsrf } from '../lib/api';
import { Field } from '../components/ui';
import type { Me } from '../lib/hooks';

function PasswordInput(props: { value: string; onChange: (v: string) => void; autoComplete: string; required?: boolean; minLength?: number }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-wrap">
      <input type={show ? 'text' : 'password'} autoComplete={props.autoComplete} required={props.required ?? true} minLength={props.minLength}
        value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} title={show ? 'Hide password' : 'Show password'}>
        {show ? (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4"/><path d="M6.6 6.7C3.9 8.5 2.5 12 2.5 12s3.5 7 9.5 7c1.5 0 2.9-.4 4.1-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>
        )}
      </button>
    </div>
  );
}

export function LoginPage({ onLogin }: { onLogin: (u: Me, csrf: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api('/auth/login', { body: { email, password } });
      setCsrf(r.csrfToken); onLogin(r.user, r.csrfToken);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? (e2.status === 429 ? 'Too many attempts. Please wait and try again.' : e2.message) : 'Could not reach the server.');
    } finally { setBusy(false); }
  };
  return (
    <div className="auth-shell">
      <aside className="auth-hero" aria-hidden="true">
        <div className="auth-brand"><span className="auth-logo">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>
        </span>IGO Groups</div>
        <h2>Every website.<br />One clear picture.</h2>
        <p>Uptime, SSL, performance and incidents for all your websites, in one secure dashboard.</p>
        <ul>
          <li><span className="dot d1" />Live uptime and incident tracking</li>
          <li><span className="dot d2" />SSL and domain expiry alerts</li>
          <li><span className="dot d3" />Performance, Analytics and Search insights</li>
        </ul>
      </aside>
      <main className="auth-panel">
        <form className="auth-card col" onSubmit={submit} aria-labelledby="t">
          <h1 id="t">Welcome back</h1>
          <p className="muted">Sign in to Website Monitoring with the account your administrator created.</p>
          {err && <div className="alert err" role="alert">{err}</div>}
          <Field label="Email address"><input type="email" autoComplete="username" required autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><PasswordInput autoComplete="current-password" value={password} onChange={setPassword} /></Field>
          <button className="btn primary auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="faint" style={{ fontSize: 12.5, margin: 0, textAlign: 'center' }}>Forgot your password? Ask an administrator to reset it.</p>
        </form>
        <p className="auth-foot">© IGO Groups · Secure access · All sign-ins are logged</p>
      </main>
    </div>
  );
}

export function ChangePasswordPage({ forced, onDone, onLogout }: { forced?: boolean; onDone: () => void; onLogout: () => void }) {
  const [cur, setCur] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [err, setErr] = useState(''); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw !== pw2) return setErr('The new passwords do not match.');
    if (pw.length < 12) return setErr('Use at least 12 characters.');
    setBusy(true);
    try { await api('/auth/change-password', { body: { currentPassword: cur, newPassword: pw } }); setOk(true); setCur(''); setPw(''); setPw2(''); setTimeout(onDone, 800); }
    catch (e2) { setErr(e2 instanceof ApiError ? e2.message : 'Request failed'); }
    finally { setBusy(false); }
  };
  const form = (
    <form className="card login-card col" onSubmit={submit} style={forced ? undefined : { maxWidth: 460 }}>
      <h1>{forced ? 'Choose a new password' : 'Change password'}</h1>
      {forced && <p className="muted">Your password was set by an administrator. Choose your own before continuing.</p>}
      {err && <div className="alert err" role="alert">{err}</div>}
      {ok && <div className="alert ok" role="status">Password changed.</div>}
      <Field label="Current password"><PasswordInput autoComplete="current-password" value={cur} onChange={setCur} /></Field>
      <Field label="New password" hint="At least 12 characters."><PasswordInput autoComplete="new-password" minLength={12} value={pw} onChange={setPw} /></Field>
      <Field label="Repeat new password"><PasswordInput autoComplete="new-password" value={pw2} onChange={setPw2} /></Field>
      <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>{forced && <button type="button" className="btn" onClick={onLogout}>Log out</button>}</div>
    </form>
  );
  return forced ? <div className="login-wrap">{form}</div> : form;
}
