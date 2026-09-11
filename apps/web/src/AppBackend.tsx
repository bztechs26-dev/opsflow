import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearSession, fetchWeek, fetchWeeks, loadSession, operationalYear, type Session, updateProductionStatus as updateProductionStatusApi, uploadWorkbook } from './api/opsflow'
import { AppShell } from './components/AppShell'
import { SignIn } from './components/SignIn'
import { DashboardPage } from './pages/DashboardPage'
import { ProductionPage } from './pages/ProductionPage'
import { ProjectionPage } from './pages/ProjectionPage'
import { ShippingPage } from './pages/ShippingPage'
import type { NavigationItem, OperationalWeek, ProductionStatus } from './types/operations'
import './App.css'

const nav: NavigationItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'production', label: 'Production', icon: 'factory' },
  { id: 'shipping', label: 'Shipping', icon: 'truck' },
  { id: 'projection', label: 'Projection', icon: 'chart' },
  { id: 'loads', label: 'Loads', icon: 'box' },
  { id: 'reports', label: 'Reports', icon: 'chart' },
]
type UploadDomain = 'production' | 'bulk-plan'

export default function AppBackend() {
  const [session, setSession] = useState<Session | null>(loadSession)
  if (!session) return <SignIn onSuccess={setSession} />
  return <OperationsApp session={session} onSignOut={() => { clearSession(); setSession(null) }} />
}

function OperationsApp({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [page, setPage] = useState('dashboard')
  const [weeks, setWeeks] = useState<OperationalWeek[]>([])
  const [weekId, setWeekId] = useState('')
  const [isUploadOpen, setIsUploadOpen] = useState(false)
  const [uploadDomain, setUploadDomain] = useState<UploadDomain>('production')
  const [isUploading, setIsUploading] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [message, setMessage] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

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
    complete: week?.productionRecords.filter((record) => record.status === 'COMPLETE').length ?? 0,
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
    try {
      const updated = await updateProductionStatusApi(
        week?.year ?? operationalYear, weekId, record.sourceArea, `record-${record.queueOrder}`, record.machine, record.zip, status, record.version, session.idToken,
      ) as { status: ProductionStatus; version?: number }
      setWeeks((items) => items.map((item) => item.id === weekId ? {
        ...item, productionRecords: item.productionRecords.map((current) => current.id === id ? { ...current, status: updated.status, version: updated.version ?? current.version } : current),
      } : item))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update production status.'
      setMessage(message)
      throw error
    }
  }

  const content = page === 'projection'
    ? <ProjectionPage weeks={weeks} selectedWeekId={weekId} token={session.idToken} />
    : !week
      ? <section className="panel empty-page"><h2>No operational weeks loaded</h2><p>Upload a Production QA workbook or Bulk Plan to add an operational week.</p></section>
      : page === 'production'
        ? <ProductionPage records={week.productionRecords} queuePlan={week.queuePlan} onStatusChange={updateProductionStatus} onNotesChange={() => undefined} onQueuePlanChange={() => undefined} />
        : page === 'shipping'
          ? <ShippingPage key={`${week.id}-${week.loads.length}`} loads={week.loads} />
          : <DashboardPage productionMetrics={metrics} loads={week.loads} records={week.productionRecords} />

  return <AppShell activePage={page} navigationItems={nav} onNavigate={setPage}>
    <div className="week-controls">
      {weeks.length > 0 && <select className="week-select" value={weekId} onChange={(event) => setWeekId(event.target.value)}>{weeks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}
      {(page === 'production' || page === 'shipping') && <button className="primary-button" onClick={() => { setUploadDomain(page === 'production' ? 'production' : 'bulk-plan'); setIsUploadOpen(true) }}>Upload {page === 'production' ? 'production' : 'Bulk Plan'}</button>}
      <button className="secondary-button" onClick={onSignOut}>Sign out</button>
    </div>
    {message && <p className="upload-error">{message}</p>}
    {content}
    {isUploadOpen && <div className="modal-backdrop"><section className="upload-modal"><h2>Upload {uploadDomain === 'production' ? 'Production QA workbook' : 'Bulk Plan'}</h2><p>The browser uploads the original file directly to private S3. Python validates and processes it after upload.</p><label>Workbook<input ref={fileInput} type="file" accept=".xlsx" /></label><div><button className="secondary-button" onClick={() => setIsUploadOpen(false)} disabled={isUploading}>Cancel</button><button className="primary-button" onClick={() => void upload()} disabled={isUploading}>{isUploading ? 'Uploading...' : 'Upload workbook'}</button></div></section></div>}
    {isProcessing && <div className="processing-overlay" role="status" aria-live="polite"><section className="processing-card"><span className="processing-spinner" aria-hidden="true" /><div><h2>Preparing your operational data</h2><p>Your workbook is being validated and added to the dashboard. This page will update automatically.</p></div></section></div>}
  </AppShell>
}

function delay(milliseconds: number) { return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)) }
