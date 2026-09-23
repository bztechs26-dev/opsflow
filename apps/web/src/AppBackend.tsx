import { useCallback, useEffect, useRef, useState } from 'react'
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
  const [weekOptions, setWeekOptions] = useState<string[]>([])
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
  const weekIdRef = useRef('')
  const loadedWeekIds = useRef(new Set<string>())

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

  const loadWeek = useCallback(async (id: string, force = false) => {
    if (!id || (!force && loadedWeekIds.current.has(id))) return
    const loaded = await fetchWeek(id, session.idToken) as OperationalWeek
    loadedWeekIds.current.add(id)
    setWeeks((items) => [...items.filter((item) => item.id !== id), loaded].sort((left, right) => Number(left.id) - Number(right.id)))
  }, [session.idToken])

  const refresh = useCallback(async () => {
    const ids = await fetchWeeks(session.idToken)
    // The current operational week is the newest available week. Keep it
    // first so a fresh sign-in never opens a prior week's data by default.
    const ordered = [...ids].sort((left, right) => Number(right) - Number(left))
    setWeekOptions(ordered)
    const selected = ordered.includes(weekIdRef.current) ? weekIdRef.current : ordered[0] ?? ''
    if (selected !== weekIdRef.current) {
      weekIdRef.current = selected
      setWeekId(selected)
    }
    if (selected) await loadWeek(selected, true)
  }, [loadWeek, session.idToken])

  const refreshCurrentWeek = useCallback(async () => {
    const selected = weekIdRef.current
    if (selected) await loadWeek(selected, true)
  }, [loadWeek])

  useEffect(() => { void refresh().catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load operations.')) }, [refresh])

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible') return
      void refreshCurrentWeek().catch((error) =>
        setMessage(error instanceof Error ? error.message : 'Could not refresh operations.'),
      )
    }
    const interval = window.setInterval(refreshWhenVisible, 5_000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refreshCurrentWeek])

  const selectWeek = useCallback(async (selected: string) => {
    weekIdRef.current = selected
    setWeekId(selected)
    try { await loadWeek(selected, true) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load the selected operational week.') }
  }, [loadWeek])

  const ensureWeeksLoaded = useCallback(async (ids: string[]) => {
    await Promise.all([...new Set(ids)].filter(Boolean).map((id) => loadWeek(id)))
  }, [loadWeek])

  const week = weeks.find((item) => item.id === weekId)

  const navigate = useCallback((nextPage: string) => {
    setPage(nextPage)
    void refreshCurrentWeek().catch((error) =>
      setMessage(error instanceof Error ? error.message : 'Could not refresh operations.'),
    )
  }, [refreshCurrentWeek])

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

  const updateProductionNotes = (id: string, notes: string) => {
    const record = week?.productionRecords.find((item) => item.id === id)
    if (!record?.sourceArea) return
    setWeeks((items) => items.map((item) => item.id === weekId ? { ...item, productionRecords: item.productionRecords.map((current) => current.id === id ? { ...current, notes } : current) } : item))
    void updateProductionStatusApi(week?.year ?? operationalYear, weekId, record.sourceArea, `record-${record.queueOrder}`, record.machine, record.zip, record.status, record.version, session.idToken, notes)
      .catch((error) => setMessage(error instanceof Error ? error.message : 'Could not save the production note.'))
  }

  const moveProductionZip = async (id: string, targetMachine: string) => {
    const record = week?.productionRecords.find((item) => item.id === id)
    if (!record?.sourceArea) {
      setMessage('This production record is missing its operational identity. Refresh and try again.')
      return
    }
    try {
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
      setMessage(`${record.zip} moved from ${record.machine} to ${updated.machine ?? targetMachine}.`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not move the ZIP to the selected machine.'
      setMessage(detail)
      throw error
    }
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
    ? <ProjectionPage weeks={weeks} availableWeekIds={weekOptions} selectedWeekId={weekId} token={session.idToken} onDataChanged={refresh} onWeekSelected={selectWeek} onEnsureWeeksLoaded={ensureWeeksLoaded} />
    : !week
      ? <section className="panel empty-page"><h2>No operational weeks loaded</h2><p>Upload a Production QA workbook or Bulk Plan to add an operational week.</p></section>
      : page === 'production'
        ? <ProductionPage records={week.productionRecords} queuePlan={week.queuePlan} onStatusChange={updateProductionStatus} onMove={moveProductionZip} onNotesChange={updateProductionNotes} onQueuePlanChange={() => undefined} />
        : page === 'shipping'
          ? <ShippingPage key={`${week.id}-${week.loads.length}`} loads={week.loads} onStatusChange={updateShippingStatus} onHubAssignmentChange={updateShippingHubAssignment} />
          : <DashboardPage loads={week.loads} records={week.productionRecords} />

  return <AppShell activePage={page} navigationItems={nav} onNavigate={navigate} operationalWeek={week?.label}>
    <div className="week-controls">
      {weekOptions.length > 0 && <select className="week-select" value={weekId} onChange={(event) => void selectWeek(event.target.value)}>{weekOptions.map((id) => <option key={id} value={id}>Week {id}</option>)}</select>}
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
