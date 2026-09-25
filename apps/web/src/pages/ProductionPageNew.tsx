import { useMemo, useState } from 'react'
import { allowedMachineRates, capacityForMachine, configuredMachineRate, formatMachineRate, formatRunHours, machineMarketQueue, machineRate } from '../data/machineCapacity'
import { CapacityStaffingPlanner } from '../components/CapacityStaffingPlanner'
import type { ProductionRecord, ProductionStatus, QueuePlan } from '../types/operations'
import './ProductionPage.css'

const statuses: ProductionStatus[] = ['NOT_STARTED', 'COMPLETE', 'BLOCKED', 'SKIPPED', 'REWORK']
const initialRenderLimit = 200
const renderLimitStep = 200
const areas = [
  { id: 'ALL', label: 'All operations' },
  { id: 'FE', label: 'Front End' },
  { id: 'BE', label: 'Back End' },
  { id: 'PROV-BOST', label: 'Providence / Boston' },
  { id: 'MMSI', label: 'MMSI' },
]

interface Props {
  records: ProductionRecord[]
  queuePlan?: QueuePlan
  onStatusChange: (id: string, status: ProductionStatus) => void | Promise<void>
  onMove?: (id: string, machine: string) => void | Promise<void>
  onNotesChange: (id: string, notes: string) => void
  onQueuePlanChange: (plan: QueuePlan) => void
  machineRates?: Record<string, number>
  onMachineRateChange?: (machine: string, rate: number) => void | Promise<void>
}

export function ProductionPage({ records, queuePlan, onStatusChange, onMove, onNotesChange, onQueuePlanChange, machineRates = {}, onMachineRateChange }: Props) {
  const [productionView, setProductionView] = useState<'zip' | 'staffing'>('zip')
  const [area, setArea] = useState('ALL')
  const [machine, setMachine] = useState('ALL')
  const [query, setQuery] = useState('')
  const [isMachineProgressOpen, setIsMachineProgressOpen] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [isSavingMachineRate, setIsSavingMachineRate] = useState(false)
  const [renderLimit, setRenderLimit] = useState(initialRenderLimit)

  const areaRecords = records.filter((record) => area === 'ALL' || recordArea(record) === area)
  const machines = useMemo(() => uniqueMachines(areaRecords), [areaRecords])
  const availableMachines = useMemo(() => uniqueMachines(records), [records])
  const normalizedQuery = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  const visible = areaRecords.filter((record) => {
    return (machine === 'ALL' || record.machine === machine)
      && (!normalizedQuery || normalizeAtz(record.zip).includes(normalizedQuery))
  })
  const complete = visible.filter(isProcessed).length
  const percent = visible.length ? Math.round((complete / visible.length) * 100) : 0
  // Keep the full result set for search and progress, but only create a
  // manageable number of editable browser rows at once.  Rendering thousands
  // of selects and inputs was delaying the operator's next action.
  const renderedRecords = visible.slice(0, renderLimit)
  const markets = [...new Set(renderedRecords.map((record) => record.market))]
  const selectedMachineRate = machine === 'ALL' ? undefined : (configuredMachineRate(machineRates, machine) ?? machineRate(machine))
  const selectedMachineCapacity = machine === 'ALL' ? undefined : capacityForMachine(machine, visible, selectedMachineRate)
  const productionNavigation = <nav className="production-subnav" aria-label="Production views"><button className={productionView === 'zip' ? 'active' : ''} type="button" onClick={() => setProductionView('zip')}>ZIP operations</button><button className={productionView === 'staffing' ? 'active' : ''} type="button" onClick={() => setProductionView('staffing')}>Capacity & staffing</button></nav>

  const changeStatus = async (record: ProductionRecord, status: ProductionStatus) => {
    setSavingId(record.id)
    try { await onStatusChange(record.id, status) }
    finally { setSavingId(null) }
  }

  const changeMachine = async (record: ProductionRecord, targetMachine: string) => {
    if (!onMove || targetMachine === record.machine) return
    setMovingId(record.id)
    try { await onMove(record.id, targetMachine) }
    finally { setMovingId(null) }
  }

  const changeMachineRate = async (rate: number) => {
    if (machine === 'ALL' || !onMachineRateChange || rate === selectedMachineRate) return
    setIsSavingMachineRate(true)
    try {
      await onMachineRateChange(machine, rate)
    } finally {
      setIsSavingMachineRate(false)
    }
  }

  if (productionView === 'staffing') return <section className="page"><div className="page-heading"><div><h1>Capacity & staffing</h1><p>Plan one machine at a time, then compare staffing needs across the operation.</p></div></div>{productionNavigation}<CapacityStaffingPlanner records={records} plan={queuePlan} onChange={onQueuePlanChange}/></section>

  return <section className="page">
    <div className="page-heading"><div><h1>Production</h1><p>Track ZIP-level production readiness by operational area and machine.</p></div></div>
    {productionNavigation}
    <div className="area-tabs">{areas.map((item) => <button key={item.id} className={area === item.id ? 'area-tab active' : 'area-tab'} onClick={() => { setArea(item.id); setMachine('ALL'); setRenderLimit(initialRenderLimit) }}>{item.label}<span>{item.id === 'ALL' ? records.length : records.filter((record) => recordArea(record) === item.id).length}</span></button>)}</div>
    <section className="production-sticky">
      <div className="production-summary">
        <span><strong>{areas.find((item) => item.id === area)?.label}</strong></span>
        <span><strong>{visible.length}</strong> ZIP records</span>
        <span><strong>{complete}</strong> complete</span>
        <span><strong>{visible.filter((record) => record.status === 'BLOCKED').length}</strong> short</span>
        <label className="production-search">Search ZIP / ATZ<input value={query} onChange={(event) => { setQuery(event.target.value); setRenderLimit(initialRenderLimit) }} placeholder="e.g. 02138 C1" /></label>
        <label className="machine-filter">Machine<select className="week-select" value={machine} onChange={(event) => { setMachine(event.target.value); setRenderLimit(initialRenderLimit) }}><option value="ALL">All machines</option>{machines.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        {machine !== 'ALL' && selectedMachineRate && <label className="machine-filter machine-rate-control"><span>Run rate</span><div><select className="week-select" value={selectedMachineRate} disabled={isSavingMachineRate} aria-label={`Run rate for ${machine}`} onChange={(event) => void changeMachineRate(Number(event.target.value))}>{allowedMachineRates(machine).map((rate) => <option key={rate} value={rate}>{formatMachineRate(rate)}</option>)}</select><small>per hour</small></div></label>}
      </div>
      <section className="panel selected-machine"><div className="panel-header"><h2>{machine === 'ALL' ? 'All machines' : machine} progress</h2><span>{complete} / {visible.length} ZIPs processed</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div><div className="progress-label"><span>{percent}% processed</span><span>{visible.length - complete} remaining</span></div>{selectedMachineCapacity && <div className="machine-time-summary"><strong>{formatRunHours(selectedMachineCapacity.estimatedHours)}</strong><span>estimated time remaining for runnable ZIPs</span></div>}</section>
    </section>
    <section className="panel machine-progress"><button className="machine-progress-toggle" type="button" onClick={() => setIsMachineProgressOpen((open) => !open)}><span><strong>Machine progress</strong><small>{machines.length} machines in this area</small></span><span className="toggle-label">{isMachineProgressOpen ? 'Hide details' : 'Show details'}<span aria-hidden="true">{isMachineProgressOpen ? '-' : '+'}</span></span></button>{isMachineProgressOpen && <div className="machine-grid">{machines.map((name) => <MachineCard key={name} name={name} records={areaRecords.filter((record) => record.machine === name)} activeRate={configuredMachineRate(machineRates, name)} />)}</div>}</section>
    {markets.map((market) => <MarketTable key={market} market={market} records={renderedRecords.filter((record) => record.market === market)} machines={availableMachines} savingId={savingId} movingId={movingId} onStatusChange={changeStatus} onMachineChange={changeMachine} onNotesChange={onNotesChange} />)}
    {visible.length > renderedRecords.length && <section className="panel production-result-limit"><span>Showing {renderedRecords.length.toLocaleString()} of {visible.length.toLocaleString()} ZIP records</span><button className="secondary-button" type="button" onClick={() => setRenderLimit((current) => current + renderLimitStep)}>Load {Math.min(renderLimitStep, visible.length - renderedRecords.length).toLocaleString()} more</button></section>}
    {!visible.length && <section className="panel empty-page"><h2>No ZIP / ATZ records found</h2><p>Try a different ZIP/ATZ search, machine, or operational-area filter.</p></section>}
  </section>
}

function MarketTable({ market, records, machines, savingId, movingId, onStatusChange, onMachineChange, onNotesChange }: { market: string; records: ProductionRecord[]; machines: string[]; savingId: string | null; movingId: string | null; onStatusChange: (record: ProductionRecord, status: ProductionStatus) => Promise<void>; onMachineChange: (record: ProductionRecord, targetMachine: string) => Promise<void>; onNotesChange: (id: string, notes: string) => void }) {
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  return <section className="market-section"><div className="market-header"><h2>{market}</h2><span>{records.length} ZIP records</span></div><div className="panel table-wrap"><table className="data-table"><thead><tr><th>ZIP / ATZ</th><th>Scheduled machine</th><th>Moved machine</th><th>Quantity</th><th>Job number</th><th>Dashboard status</th><th>Notes</th><th>Update status</th></tr></thead><tbody>{records.map((record) => { const locked = isProcessed(record); const note = noteDrafts[record.id] ?? record.notes ?? ''; return <tr key={record.id} className={record.movedAt ? 'zip-moved-row' : ''}><td>{record.zip}{record.movedAt && <span className="moved-flag">MOVED</span>}</td><td>{record.scheduledMachine || record.machine}</td><td>{machines.length ? <select className="status-select" value={record.machine} disabled={locked || movingId === record.id} aria-label={`Move ${record.zip} to another machine`} onChange={(event) => void onMachineChange(record, event.target.value)}>{machines.map((machine) => <option key={machine} value={machine}>{machine}</option>)}</select> : record.machine}{locked && <span className="locked-note">Processed</span>}</td><td>{record.volume.toLocaleString()} pcs</td><td>{record.jobNumber || '-'}</td><td><StatusBadge status={record.status} /></td><td><input className="notes-input" maxLength={100} placeholder="Add note" value={note} onChange={(event) => setNoteDrafts((drafts) => ({ ...drafts, [record.id]: event.target.value }))} onBlur={() => { if (note !== (record.notes ?? '')) onNotesChange(record.id, note) }} /></td><td><select className="status-select" value={record.status} disabled={savingId === record.id} onChange={(event) => void onStatusChange(record, event.target.value as ProductionStatus)}>{statuses.map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}</select></td></tr> })}</tbody></table></div></section>
}

function MachineCard({ name, records, activeRate }: { name: string; records: ProductionRecord[]; activeRate?: number }) {
  const capacity = capacityForMachine(name, records, activeRate)
  if (!capacity) return null
  const queue = machineMarketQueue(records)
  const marketText = queue.map((item) => `${item.market} ${item.pieces.toLocaleString()} pcs`).join(' · ')
  return <div className="machine-item"><div className="progress-label"><span>{name}</span><strong>{capacity.percentComplete}%</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${capacity.percentComplete}%` }} /></div><div className="machine-queue-line"><strong>{capacity.runnablePieces.toLocaleString()} pcs remaining</strong><span>{queue.length ? `Next: ${queue[0].market}` : 'Queue complete'}</span></div>{queue.length > 0 && <div className="machine-market-queue" title={marketText}>{marketText}</div>}<div className="machine-runtime"><strong>{formatRunHours(capacity.estimatedHours)}</strong><span>{formatMachineRate(capacity.rate)}/hr</span></div><div className="metric-detail">{capacity.completePieces.toLocaleString()} of {capacity.totalPieces.toLocaleString()} pcs processed</div></div>
}

function uniqueMachines(records: ProductionRecord[]) { return [...new Set(records.map((record) => record.machine))].filter((name) => machineRate(name) > 0).sort() }
function recordArea(record: ProductionRecord) { return record.sourceArea ?? (record.id.includes('-PROV-BOST-') ? 'PROV-BOST' : record.id.includes('-BE-') ? 'BE' : record.id.includes('-MMSI-') ? 'MMSI' : 'FE') }
function normalizeAtz(value: string) { return value.toUpperCase().replace(/[^A-Z0-9]/g, '') }
function isProcessed(record: ProductionRecord) { return record.status === 'COMPLETE' || record.status === 'BLOCKED' }
function formatStatus(status: string) { return status === 'BLOCKED' ? 'SHORT' : status === 'SKIPPED' ? 'SKIP' : status.replaceAll('_', ' ') }
function StatusBadge({ status }: { status: string }) { return <span className={`status ${status.toLowerCase()}`}>{formatStatus(status)}</span> }
