import { useMemo, useState } from 'react'
import { capacityForMachine, formatRunHours, machineRate } from '../data/machineCapacity'
import type { ProductionRecord, ProductionStatus, QueuePlan } from '../types/operations'
import './ProductionPage.css'

const statuses: ProductionStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'BLOCKED', 'SKIPPED']
const areas = [{ id: 'ALL', label: 'All operations' }, { id: 'FE', label: 'Front End' }, { id: 'BE', label: 'Back End' }, { id: 'PROV-BOST', label: 'Providence / Boston' }, { id: 'MMSI', label: 'MMSI' }]
interface Props { records: ProductionRecord[]; queuePlan?: QueuePlan; onStatusChange: (id: string, status: ProductionStatus) => void | Promise<void>; onNotesChange: (id: string, notes: string) => void; onQueuePlanChange: (plan: QueuePlan) => void }

export function ProductionPage({ records, onStatusChange, onNotesChange }: Props) {
  const [area, setArea] = useState('ALL')
  const [machine, setMachine] = useState('ALL')
  const [query, setQuery] = useState('')
  const [isMachineProgressOpen, setIsMachineProgressOpen] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [statusFeedback, setStatusFeedback] = useState<Record<string, string>>({})
  const areaRecords = records.filter((record) => area === 'ALL' || recordArea(record) === area)
  const machines = useMemo(() => [...new Set(areaRecords.map((record) => record.machine))].filter((name) => machineRate(name) > 0).sort(), [areaRecords])
  const normalizedQuery = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  const visible = areaRecords.filter((record) => (machine === 'ALL' || record.machine === machine) && (!normalizedQuery || normalizeAtz(record.zip).includes(normalizedQuery)))
  const complete = visible.filter((record) => record.status === 'COMPLETE').length
  const percent = visible.length ? Math.round(complete / visible.length * 100) : 0
  const markets = [...new Set(visible.map((record) => record.market))]
  const selectedMachineLabel = machine === 'ALL' ? 'All machines' : machine
  const selectedMachineCapacity = machine === 'ALL' ? undefined : capacityForMachine(machine, visible)
  const changeStatus = async (record: ProductionRecord, status: ProductionStatus) => {
    setSavingId(record.id)
    setStatusFeedback((current) => ({ ...current, [record.id]: 'Saving…' }))
    try {
      await onStatusChange(record.id, status)
      setStatusFeedback((current) => ({ ...current, [record.id]: 'Saved' }))
    } catch {
      setStatusFeedback((current) => ({ ...current, [record.id]: 'Could not save. Try again.' }))
    } finally {
      setSavingId(null)
    }
  }

  return <section className="page">
    <div className="page-heading"><div><h1>Production</h1><p>Track ZIP-level production readiness by operational area and machine.</p></div></div>
    <div className="area-tabs">{areas.map((item) => <button key={item.id} className={area === item.id ? 'area-tab active' : 'area-tab'} onClick={() => { setArea(item.id); setMachine('ALL') }}>{item.label}<span>{item.id === 'ALL' ? records.length : records.filter((record) => recordArea(record) === item.id).length}</span></button>)}</div>
    <section className="production-sticky">
      <div className="production-summary">
        <span><strong>{areas.find((item) => item.id === area)?.label}</strong></span><span><strong>{visible.length}</strong> ZIP records</span><span><strong>{complete}</strong> complete</span><span><strong>{visible.filter((record) => record.status === 'BLOCKED').length}</strong> short</span>
        <label className="production-search">Search ZIP / ATZ<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. 02138 C1" aria-label="Search ZIP or ATZ" /></label>
        <label className="machine-filter">Machine<select className="week-select" value={machine} onChange={(event) => setMachine(event.target.value)}><option value="ALL">All machines</option>{machines.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      </div>
      <section className="panel selected-machine"><div className="panel-header"><h2>{selectedMachineLabel} progress</h2><span>{complete} / {visible.length} ZIPs complete</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div><div className="progress-label"><span>{percent}% completed</span><span>{visible.length - complete} remaining</span></div>{selectedMachineCapacity && <div className="machine-time-summary"><strong>{formatRunHours(selectedMachineCapacity.estimatedHours)}</strong><span>estimated time remaining for runnable ZIPs</span>{(selectedMachineCapacity.blockedPieces > 0 || selectedMachineCapacity.skippedPieces > 0) && <small>{selectedMachineCapacity.blockedPieces > 0 ? `${selectedMachineCapacity.blockedPieces.toLocaleString()} pcs short` : ''}{selectedMachineCapacity.blockedPieces > 0 && selectedMachineCapacity.skippedPieces > 0 ? ' · ' : ''}{selectedMachineCapacity.skippedPieces > 0 ? `${selectedMachineCapacity.skippedPieces.toLocaleString()} pcs skipped` : ''}</small>}</div>}</section>
    </section>
    <section className="panel machine-progress"><button className="machine-progress-toggle" type="button" aria-expanded={isMachineProgressOpen} aria-controls="machine-progress-details" onClick={() => setIsMachineProgressOpen((isOpen) => !isOpen)}><span><strong>Machine progress</strong><small>{machines.length} machines in this area</small></span><span className="toggle-label">{isMachineProgressOpen ? 'Hide details' : 'Show details'}<span aria-hidden="true">{isMachineProgressOpen ? '−' : '+'}</span></span></button>{isMachineProgressOpen && <div id="machine-progress-details" className="machine-grid">{machines.map((name) => <MachineCard key={name} name={name} records={areaRecords.filter((record) => record.machine === name)} />)}</div>}</section>
    {markets.map((market) => <section key={market} className="market-section"><div className="market-header"><h2>{market}</h2><span>{visible.filter((record) => record.market === market).length} ZIP records</span></div><div className="panel table-wrap"><table className="data-table"><thead><tr><th>ZIP / ATZ</th><th>Machine</th><th>Quantity</th><th>Source status</th><th>Dashboard status</th><th>Notes</th><th>Update status</th></tr></thead><tbody>{visible.filter((record) => record.market === market).map((record) => <tr key={record.id}><td>{record.zip}</td><td>{record.machine}</td><td>{record.volume.toLocaleString()} pcs</td><td>{record.sourceStatus}</td><td><StatusBadge status={record.status}/></td><td><input className="notes-input" maxLength={100} placeholder="Add note" value={record.notes ?? ''} onChange={(event) => onNotesChange(record.id, event.target.value)} /></td><td><select className="status-select" value={record.status} disabled={savingId === record.id} onChange={(event) => void changeStatus(record, event.target.value as ProductionStatus)}>{statuses.map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}</select>{statusFeedback[record.id] && <small className={statusFeedback[record.id] === 'Saved' ? 'status-save-message saved' : statusFeedback[record.id] === 'Saving…' ? 'status-save-message' : 'status-save-message failed'}>{statusFeedback[record.id]}</small>}</td></tr>)}</tbody></table></div></section>)}
    {!visible.length && <section className="panel empty-page"><h2>No ZIP / ATZ records found</h2><p>Try a different ZIP/ATZ search, machine, or operational-area filter.</p></section>}
  </section>
}

function MachineCard({ name, records }: { name: string; records: ProductionRecord[] }) { const capacity = capacityForMachine(name, records); if (!capacity) return null; const markets = [...new Set(records.filter((record) => record.status !== 'COMPLETE').map((record) => record.market))]; return <div className="machine-item"><div className="progress-label"><span>{name}</span><strong>{capacity.percentComplete}%</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${capacity.percentComplete}%` }} /></div><div className="metric-detail"><strong>{capacity.runnablePieces.toLocaleString()} pcs runnable</strong>{markets.length ? ` · ${markets.join(', ')}` : ' · Complete'}</div><div className="machine-runtime"><strong>{formatRunHours(capacity.estimatedHours)}</strong></div>{(capacity.blockedPieces > 0 || capacity.skippedPieces > 0) && <div className="machine-exceptions">{capacity.blockedPieces > 0 ? `${capacity.blockedPieces.toLocaleString()} pcs short` : ''}{capacity.blockedPieces > 0 && capacity.skippedPieces > 0 ? ' · ' : ''}{capacity.skippedPieces > 0 ? `${capacity.skippedPieces.toLocaleString()} pcs skipped` : ''}</div>}<div className="metric-detail">{capacity.completePieces.toLocaleString()} of {capacity.totalPieces.toLocaleString()} pcs complete</div></div> }
function recordArea(record: ProductionRecord) { return record.sourceArea ?? (record.id.includes('-PROV-BOST-') ? 'PROV-BOST' : record.id.includes('-BE-') ? 'BE' : record.id.includes('-MMSI-') ? 'MMSI' : 'FE') }
function normalizeAtz(value: string) { return value.toUpperCase().replace(/[^A-Z0-9]/g, '') }
export function formatStatus(status: string) { return status === 'BLOCKED' ? 'SHORT' : status.replaceAll('_', ' ') }
export function StatusBadge({ status }: { status: string }) { return <span className={`status ${status.toLowerCase()}`}>{formatStatus(status)}</span> }
