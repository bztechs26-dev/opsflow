import { useCallback, useEffect, useRef, useState } from 'react'
import { clearSession, continueSession as continueSessionApi, fetchWeek, fetchWeekVersion, fetchWeeks, loadSession, moveProductionZip as moveProductionZipApi, operationalYear, type Session, updateMachineRate as updateMachineRateApi, updateProductionStatus as updateProductionStatusApi, updateQueuePlan as updateQueuePlanApi, updateShippingHubAssignment as updateShippingHubAssignmentApi, updateShippingStatus as updateShippingStatusApi, uploadWorkbook } from './api/opsflow'
import { AppShell } from './components/AppShell'
import { SignIn } from './components/SignIn'
import { machineRateKey } from './data/machineCapacity'
import { DashboardPage } from './pages/DashboardPage'
import { ProductionPage } from './pages/ProductionPageNew'
import { ProjectionPage } from './pages/ProjectionPage'
import { ShippingPage } from './pages/ShippingPage'
import type { NavigationItem, OperationalWeek, ProductionStatus, QueuePlan } from './types/operations'
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
  const initialWeekSelected = useRef(false)
  const inFlightWeekRefreshes = useRef(new Set<string>())
  const knownWeekVersions = useRef(new Map<string, string>())
  // A background refresh can complete while a rate PATCH is still in flight.
  // Keep the operator's selected rate authoritative until DynamoDB returns
  // that same value, instead of briefly reverting the selector to its default.
  const pendingMachineRates = useRef(new Map<string, number>())

  const mergePendingMachineRates = useCallback((loaded: OperationalWeek): OperationalWeek => {
    const rates = { ...(loaded.machineRates ?? {}) }
    const prefix = `${loaded.id}:`
    let hasPending = false
    for (const [pendingKey, pendingRate] of pendingMachineRates.current) {
      if (!pendingKey.startsWith(prefix)) continue
      const machineKey = pendingKey.slice(prefix.length)
      if (rates[machineKey] === pendingRate) {
        pendingMachineRates.current.delete(pendingKey)
      } else {
        rates[machineKey] = pendingRate
        hasPending = true
      }
    }
    return hasPending ? { ...loaded, machineRates: rates } : loaded
  }, [])

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
    if (inFlightWeekRefreshes.current.has(id)) return
    inFlightWeekRefreshes.current.add(id)
    try {
      const version = await fetchWeekVersion(id, session.idToken)
      const loaded = mergePendingMachineRates(await fetchWeek(id, session.idToken) as OperationalWeek)
      knownWeekVersions.current.set(id, version)
      loadedWeekIds.current.add(id)
      setWeeks((items) => {
        const current = items.find((item) => item.id === id)
        // The five-second check returns the whole week. Keep the existing UI
        // untouched when no operational data has actually changed.
        if (current && JSON.stringify(current) === JSON.stringify(loaded)) return items
        return [...items.filter((item) => item.id !== id), loaded].sort((left, right) => Number(left.id) - Number(right.id))
      })
    } finally {
      inFlightWeekRefreshes.current.delete(id)
    }
  }, [mergePendingMachineRates, session.idToken])

  const refresh = useCallback(async () => {
    const ids = await fetchWeeks(session.idToken)
    // The current operational week is the newest available week. Keep it
    // first so a fresh sign-in never opens a prior week's data by default.
    const ordered = [...ids].sort((left, right) => Number(right) - Number(left))
    setWeekOptions(ordered)
    const newestWeek = ordered[0] ?? ''
    // Do not preserve a selection until this session has explicitly selected
    // its initial week. This makes a new sign-in deterministic even when
    // React starts more than one initial data request in development mode.
    const selected = initialWeekSelected.current && ordered.includes(weekIdRef.current)
      ? weekIdRef.current
      : newestWeek
    initialWeekSelected.current = true
    if (selected !== weekIdRef.current) {
      weekIdRef.current = selected
      setWeekId(selected)
    }
    if (selected) await loadWeek(selected, true)
  }, [loadWeek, session.idToken])

  const refreshCurrentWeek = useCallback(async () => {
    const selected = weekIdRef.current
    if (!selected) return
    const version = await fetchWeekVersion(selected, session.idToken)
    if (knownWeekVersions.current.get(selected) === version) return
    knownWeekVersions.current.set(selected, version)
    await loadWeek(selected, true)
  }, [loadWeek, session.idToken])

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

  const updateMachineRate = async (machine: string, rate: number) => {
    const rateKey = machineRateKey(machine)
    const pendingKey = `${weekId}:${rateKey}`
    const previous = week?.machineRates?.[rateKey] ?? week?.machineRates?.[machine]
    pendingMachineRates.current.set(pendingKey, rate)
    setWeeks((items) => items.map((item) => item.id === weekId ? {
      ...item, machineRates: { ...(item.machineRates ?? {}), [rateKey]: rate },
    } : item))
    try {
      await updateMachineRateApi(week?.year ?? operationalYear, weekId, machine, rate, session.idToken)
      // Re-read after the PATCH. mergePendingMachineRates protects this value
      // if DynamoDB's normal read briefly returns the prior item version.
      void loadWeek(weekId, true).catch((error) =>
        setMessage(error instanceof Error ? error.message : 'Could not refresh the machine rate.'),
      )
    } catch (error) {
      pendingMachineRates.current.delete(pendingKey)
      setWeeks((items) => items.map((item) => item.id === weekId ? {
        ...item, machineRates: (() => { const restored = { ...(item.machineRates ?? {}) }; if (previous === undefined) delete restored[rateKey]; else restored[rateKey] = previous; return restored })(),
      } : item))
      setMessage(error instanceof Error ? error.message : 'Could not save the machine hourly rate.')
      throw error
    }
  }

  const updateQueuePlan = async (plan: QueuePlan) => {
    const prior = week?.queuePlan
    setWeeks((items) => items.map((item) => item.id === weekId ? { ...item, queuePlan: plan } : item))
    try {
      const saved = await updateQueuePlanApi(week?.year ?? operationalYear, weekId, plan, session.idToken)
      setWeeks((items) => items.map((item) => item.id === weekId ? { ...item, queuePlan: saved as QueuePlan } : item))
    } catch (error) {
      setWeeks((items) => items.map((item) => item.id === weekId ? { ...item, queuePlan: prior } : item))
      setMessage(error instanceof Error ? error.message : 'Could not save the Capacity & Staffing plan.')
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

  // Keep each module mounted when the operator changes navigation.  Its local
  // filters, selected machine/market, search, and expanded details therefore
  // remain exactly where the operator left them, while the shared week data
  // can still refresh in the background.
  const content = !week
    ? <section className="panel empty-page"><h2>No operational weeks loaded</h2><p>Upload a Production QA workbook or Bulk Plan to add an operational week.</p></section>
    : <>
      <div hidden={page !== 'dashboard'}><DashboardPage loads={week.loads} records={week.productionRecords} machineRates={week.machineRates} /></div>
      <div hidden={page !== 'production'}><ProductionPage records={week.productionRecords} queuePlan={week.queuePlan} machineRates={week.machineRates} onMachineRateChange={updateMachineRate} onStatusChange={updateProductionStatus} onMove={moveProductionZip} onNotesChange={updateProductionNotes} onQueuePlanChange={updateQueuePlan} /></div>
      <div hidden={page !== 'shipping'}><ShippingPage loads={week.loads} onStatusChange={updateShippingStatus} onHubAssignmentChange={updateShippingHubAssignment} /></div>
      <div hidden={page !== 'projection'}><ProjectionPage weeks={weeks} availableWeekIds={weekOptions} selectedWeekId={weekId} token={session.idToken} onDataChanged={refresh} onWeekSelected={selectWeek} onEnsureWeeksLoaded={ensureWeeksLoaded} /></div>
    </>

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
