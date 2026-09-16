import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearSession, continueSession as continueSessionApi, fetchWeek, fetchWeeks, loadSession, moveProductionZip as moveProductionZipApi, operationalYear, type Session, updateProductionStatus as updateProductionStatusApi, updateShippingHubAssignment as updateShippingHubAssignmentApi, updateShippingStatus as updateShippingStatusApi, uploadWorkbook } from './api/opsflow'
import { AppShell } from './components/AppShell'
import { SignIn } from './components/SignIn'
import { DashboardPage } from './pages/DashboardPage'
import { ProductionPage } from './pages/ProductionPageNew'
import { ProjectionPage } from './pages/ProjectionPage'
import { ShippingPage } from './pages/ShippingPage'
import type { NavigationItem, OperationalWeek, ProductionStatus } from './types/operations'
import './App.css'

const nav: NavigationItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'production', label: 'Production', icon: 'factory' },
  { id: 'shipping', label: 'Shipping', icon: 'truck' },
  { id: 'projection', label: 'Projection', icon: 'chart' },
]
type UploadDomain = 'production' | 'bulk-plan'
const idleWarningMs = 60 * 60 * 1000
const idleSignOutMs = 65 * 60 * 1000
const shiftWarningMs = 11.75 * 60 * 60 * 1000
const shiftSignOutMs = 12 * 60 * 60 * 1000

export default function AppBackend() {
  const [session, setSession] = useState<Session | null>(loadSession)
  if (!session) return <SignIn onSuccess={setSession} />
  return <OperationsApp session={session} onSessionChange={setSession} onSignOut={() => { clearSession(); setSession(null) }} />
}

function OperationsApp({ session, onSessionChange, onSignOut }: { session: Session; onSessionChange: (session: Session) => void; onSignOut: () => void }) {
  const [page, setPage] = useState('dashboard')
  const [weeks, setWeeks] = useState<OperationalWeek[]>([])
  const [weekId, setWeekId] = useState('')
  const [isUploadOpen, setIsUploadOpen] = useState(false)
  const [uploadDomain, setUploadDomain] = useState<UploadDomain>('production')
  const [isUploading, setIsUploading] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [message, setMessage] = useState('')
  const [sessionPrompt, setSessionPrompt] = useState<'idle' | 'shift' | null>(null)
  const [sessionNow, setSessionNow] = useState(Date.now())
  const [isContinuingSession, setIsContinuingSession] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const lastActivityAt = useRef(Date.now())

  useEffect(() => {
    const noteActivity = () => {
      lastActivityAt.current = Date.now()
    }
    window.addEventListener('pointerdown', noteActivity)
    window.addEventListener('keydown', noteActivity)
    window.addEventListener('touchstart', noteActivity)
    const checkSession = () => {
      const now = Date.now()
      const idleFor = now - lastActivityAt.current
      const shiftAge = now - session.startedAt
      setSessionNow(now)
      if (idleFor >= idleSignOutMs || shiftAge >= shiftSignOutMs) {
        onSignOut()
        return
      }
      if (idleFor >= idleWarningMs) setSessionPrompt('idle')
      else if (shiftAge >= shiftWarningMs) setSessionPrompt('shift')
    }
    const interval = window.setInterval(checkSession, sessionPrompt ? 1000 : 15_000)
    return () => {
      window.removeEventListener('pointerdown', noteActivity)
      window.removeEventListener('keydown', noteActivity)
      window.removeEventListener('touchstart', noteActivity)
      window.clearInterval(interval)
    }
  }, [onSignOut, session.startedAt, sessionPrompt])

  const continueWorking = async () => {
    setIsContinuingSession(true)
    try {
      onSessionChange(await continueSessionApi())
      lastActivityAt.current = Date.now()
      setSessionPrompt(null)
    } catch {
      onSignOut()
    } finally { setIsContinuingSession(false) }
  }

  const refresh = useCallback(async () => {
    const ids = await fetchWeeks(session.idToken)
    const values = await Promise.all(ids.map((id) => fetchWeek(id, session.idToken))) as OperationalWeek[]
    const ordered = values.sort((left, right) => Number(left.id) - Number(right.id))
    setWeeks(ordered)
    setWeekId((current) => ordered.some((week) => week.id === current) ? current : ordered[0]?.id ?? '')
  }, [session.idToken])

  useEffect(() => { void refresh().catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load operations.')) }, [refresh])

  const week = weeks.find((item) => item.id === weekId)
  const metrics = useMemo(() => ({
    complete: week?.productionRecords.filter((record) => record.status === 'COMPLETE' || record.status === 'BLOCKED').length ?? 0,
    total: week?.productionRecords.length ?? 0,
  }), [week])

  const upload = async () => {
    const file = fileInput.current?.files?.[0]
    if (!file) return setMessage(`Select a ${uploadDomain === 'production' ? 'Production QA' : 'Bulk Plan'} workbook.`)
    setIsUploading(true); setMessage('')
    try {
      await uploadWorkbook(uploadDomain, file, session.idToken)
      setIsUploadOpen(false)
      setIsProcessing(true)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await delay(1500)
        await refresh()
      }
      setMessage('Upload accepted. The operational data is refreshing now.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The workbook could not be uploaded.') }
    finally { setIsUploading(false); setIsProcessing(false) }
  }

  const updateProductionStatus = async (id: string, status: ProductionStatus) => {
    const record = week?.productionRecords.find((item) => item.id === id)
    if (!record?.sourceArea) {
      setMessage('This production record is missing its operational identity. Refresh and try again.')
      return
    }
    const priorStatus = record.status
    // Reflect a confirmed clerk action at once; the API response below remains
    // authoritative and replaces this value if needed.
    setWeeks((items) => items.map((item) => item.id === weekId ? {
      ...item, productionRecords: item.productionRecords.map((current) => current.id === id ? { ...current, status } : current),
    } : item))
    try {
      const updated = await updateProductionStatusApi(
        week?.year ?? operationalYear, weekId, record.sourceArea, `record-${record.queueOrder}`, record.machine, record.zip, status, record.version, session.idToken,
      ) as { status: ProductionStatus; version?: number }
      setWeeks((items) => items.map((item) => item.id === weekId ? {
        ...item, productionRecords: item.productionRecords.map((current) => current.id === id ? { ...current, status: updated.status ?? status, version: updated.version ?? current.version } : current),
      } : item))
    } catch (error) {
      setWeeks((items) => items.map((item) => item.id === weekId ? {
        ...item, productionRecords: item.productionRecords.map((current) => current.id === id ? { ...current, status: priorStatus } : current),
      } : item))
      const message = error instanceof Error ? error.message : 'Could not update production status.'
      setMessage(message)
      throw error
    }
  }

  const moveProductionZip = async (id: string, targetMachine: string) => {
    const record = week?.productionRecords.find((item) => item.id === id)
    if (!record?.sourceArea) {
      setMessage('This production record is missing its operational identity. Refresh and try again.')
      return
    }
    const updated = await moveProductionZipApi(
      week?.year ?? operationalYear, weekId, record.sourceArea, `record-${record.queueOrder}`,
      record.machine, record.zip, targetMachine, session.idToken,
    )
    setWeeks((items) => items.map((item) => item.id === weekId ? {
      ...item,
      productionRecords: item.productionRecords.map((current) => current.id === id ? {
        ...current, machine: updated.machine ?? targetMachine,
        scheduledMachine: updated.scheduledMachine ?? current.scheduledMachine,
        movedAt: updated.movedAt ?? current.movedAt,
        transferHistory: updated.transferHistory ?? current.transferHistory,
      } : current),
    } : item))
  }

  const updateShippingStatus = async (id: string, status: string, statusAt?: string) => {
    const load = week?.loads.find((item) => item.id === id)
    if (!load) {
      setMessage('This Shipping load is missing its trip identity. Refresh and try again.')
      return
    }
    try {
      const updated = await updateShippingStatusApi(week?.year ?? operationalYear, weekId, load.number, status, session.idToken, statusAt)
      setWeeks((items) => items.map((item) => item.id === weekId ? {
        ...item,
        loads: item.loads.map((current) => current.id === id ? { ...current, status: updated.status as typeof current.status, statusUpdatedAt: updated.statusUpdatedAt ?? current.statusUpdatedAt, dispatchedAt: updated.dispatchedAt ?? current.dispatchedAt } : current),
      } : item))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update Shipping status.'
      setMessage(message)
      throw error
    }
  }

  const updateShippingHubAssignment = async (id: string, hubTrip: string | undefined) => {
    const load = week?.loads.find((item) => item.id === id)
    if (!load) {
      setMessage('This Shipping load is missing its trip identity. Refresh and try again.')
      return
    }
    try {
      const updated = await updateShippingHubAssignmentApi(week?.year ?? operationalYear, weekId, load.number, hubTrip, session.idToken)
      setWeeks((items) => items.map((item) => item.id === weekId ? {
        ...item,
        loads: item.loads.map((current) => current.id === id ? { ...current, assignedHubTrip: updated.assignedHubTrip ?? undefined } : current),
      } : item))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update the hub assignment.'
      setMessage(message)
      throw error
    }
  }

  const content = page === 'projection'
    ? <ProjectionPage weeks={weeks} selectedWeekId={weekId} token={session.idToken} onDataChanged={refresh} />
    : !week
      ? <section className="panel empty-page"><h2>No operational weeks loaded</h2><p>Upload a Production QA workbook or Bulk Plan to add an operational week.</p></section>
      : page === 'production'
        ? <ProductionPage records={week.productionRecords} queuePlan={week.queuePlan} onStatusChange={updateProductionStatus} onMove={moveProductionZip} onNotesChange={() => undefined} onQueuePlanChange={() => undefined} />
        : page === 'shipping'
          ? <ShippingPage key={`${week.id}-${week.loads.length}`} loads={week.loads} onStatusChange={updateShippingStatus} onHubAssignmentChange={updateShippingHubAssignment} />
          : <DashboardPage productionMetrics={metrics} loads={week.loads} records={week.productionRecords} />

  return <AppShell activePage={page} navigationItems={nav} onNavigate={setPage} operationalWeek={week?.label}>
    <div className="week-controls">
      {weeks.length > 0 && <select className="week-select" value={weekId} onChange={(event) => setWeekId(event.target.value)}>{weeks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}
      {(page === 'production' || page === 'shipping') && <button className="primary-button" onClick={() => { setUploadDomain(page === 'production' ? 'production' : 'bulk-plan'); setIsUploadOpen(true) }}>Upload {page === 'production' ? 'production' : 'Bulk Plan'}</button>}
      <button className="secondary-button" onClick={onSignOut}>Sign out</button>
    </div>
    {message && <p className="upload-error">{message}</p>}
    {content}
    {isUploadOpen && <div className="modal-backdrop"><section className="upload-modal"><h2>Upload {uploadDomain === 'production' ? 'Production QA workbook' : 'Bulk Plan'}</h2><p>Use .xlsx, .xlsm, .xls, or .csv. Legacy files are standardized securely in the browser before processing.</p><label>Workbook<input ref={fileInput} type="file" accept=".xlsx,.xlsm,.xls,.csv" /></label><div><button className="secondary-button" onClick={() => setIsUploadOpen(false)} disabled={isUploading}>Cancel</button><button className="primary-button" onClick={() => void upload()} disabled={isUploading}>{isUploading ? 'Uploading...' : 'Upload workbook'}</button></div></section></div>}
    {isProcessing && <div className="processing-overlay" role="status" aria-live="polite"><section className="processing-card"><span className="processing-spinner" aria-hidden="true" /><div><h2>Preparing your operational data</h2><p>Your workbook is being validated and added to the dashboard. This page will update automatically.</p></div></section></div>}
    {sessionPrompt && <div className="session-overlay" role="dialog" aria-modal="true" aria-labelledby="session-prompt-title"><section className="session-card"><span className="metric-label">Session check</span><h2 id="session-prompt-title">{sessionPrompt === 'idle' ? 'Still working?' : 'Continue your OpsFlow session?'}</h2><p>{sessionPrompt === 'idle' ? 'For your security, OpsFlow will sign you out after inactivity unless you confirm you are still working.' : 'Your operational shift is approaching its session limit. Continue working to renew your secure session.'}</p><strong className="session-countdown">{formatCountdown(sessionPrompt === 'idle' ? idleSignOutMs - (sessionNow - lastActivityAt.current) : shiftSignOutMs - (sessionNow - session.startedAt))}</strong><span className="session-countdown-label">until automatic sign out</span><div className="session-actions"><button className="secondary-button" type="button" onClick={onSignOut} disabled={isContinuingSession}>Sign out</button><button className="primary-button" type="button" onClick={() => void continueWorking()} disabled={isContinuingSession}>{isContinuingSession ? 'Continuing...' : 'Continue working'}</button></div></section></div>}
  </AppShell>
}

function delay(milliseconds: number) { return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)) }
function formatCountdown(milliseconds: number) { const seconds = Math.max(0, Math.ceil(milliseconds / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
