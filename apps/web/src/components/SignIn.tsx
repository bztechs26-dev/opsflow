import { useState, type FormEvent } from 'react'
import { signIn, type Session } from '../api/opsflow'

export function SignIn({ onSuccess }: { onSuccess: (session: Session) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setMessage('')
    try { onSuccess(await signIn(username, password)) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Sign-in failed.') }
    finally { setSubmitting(false) }
  }
  return <main className="sign-in-page"><form className="sign-in-card" onSubmit={(event) => void submit(event)}><span className="metric-label">OpsFlow</span><h1>Operations sign in</h1><p>Use your Cognito account to access operational workbooks and uploads.</p><label>Email<input type="email" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>{message && <p className="upload-error">{message}</p>}<button className="primary-button" disabled={submitting}>{submitting ? 'Signing in...' : 'Sign in'}</button></form></main>
}
