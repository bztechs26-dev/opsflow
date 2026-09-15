import type { Load, ProductionRecord } from '../types/operations'
import { capacityForMachine, formatRunHours } from '../data/machineCapacity'

interface Props {
  productionMetrics: { complete: number; total: number }
  loads: Load[]
  records: ProductionRecord[]
  onNavigate?: (page: 'production' | 'shipping') => void
}

const areaLabels: Record<string, string> = { FE: 'Front End', BE: 'Back End', 'PROV-BOST': 'Providence / Boston', MMSI: 'MMSI' }

export function DashboardPage({ productionMetrics, loads, records, onNavigate }: Props) {
  const totalHH = records.reduce((sum, record) => sum + record.volume, 0)
  const completeHH = records.filter((record) => record.status === 'COMPLETE').reduce((sum, record) => sum + record.volume, 0)
  const percent = totalHH ? Math.round((completeHH / totalHH) * 100) : 0
  const machines = groupBy(records, (record) => record.machine)
  const productionMachines = Object.entries(machines).filter(([machine, items]) => Boolean(capacityForMachine(machine, items)))
  const areaProgress = Object.entries(groupBy(records, recordArea)).map(([area, items]) => ({ ...progressFor(items), key: area }))
  const deliveryStatuses = ['NOT_STARTED', 'STAGED', 'LOADED', 'DISPATCHED', 'DELAYED', 'CLOSED'] as const
  const deliverySummary = deliveryStatuses.map((status) => ({ status, count: loads.filter((load) => load.status === status).length }))
  const delayedLoads = loads.filter((load) => load.status === 'DELAYED')
  const loadedLoads = loads.filter((load) => load.status === 'LOADED')
  const blockedRecords = records.filter((record) => record.status === 'BLOCKED')
  const longestRunningMachine = productionMachines
    .map(([machine, items]) => capacityForMachine(machine, items))
    .filter((capacity): capacity is NonNullable<typeof capacity> => Boolean(capacity))
    .sort((left, right) => (right.estimatedHours ?? 0) - (left.estimatedHours ?? 0))[0]
  const followUpCount = delayedLoads.length + loadedLoads.length + blockedRecords.length

  return <section className="page">
    <div className="page-heading"><div><h1>Operations dashboard</h1><p>Weekly readiness, household progress, active markets, and machine capacity.</p></div></div>
    <div className="metric-grid">
      <Metric label="Total loads" value={String(loads.length)} detail="Imported from weekly Bulk Plan" />
      <Metric label="HH completion" value={`${percent}%`} detail={`${completeHH.toLocaleString()} HH complete · ${productionMetrics.complete} ZIPs finished`} />
      <Metric label="HH remaining" value={(totalHH - completeHH).toLocaleString()} detail="Production quantity still running" />
      <Metric label="Follow-ups" value={String(followUpCount)} detail="Delayed, loaded, or blocked work" />
    </div>
    <div className="dashboard-grid">
      <section className="panel chart-panel"><div className="panel-header"><h2>Production completion by area</h2><span>Completed household quantity</span></div><div className="bar-chart">{areaProgress.map(({ key, complete, total, percent: areaPercent }) => <ProgressBar key={key} label={areaLabels[key] ?? key} value={complete} total={total} percent={areaPercent} />)}</div></section>
      <section className="panel chart-panel"><div className="panel-header"><h2>Shipping delivery state</h2><span>{loads.length} planned loads</span></div><DeliveryDonut total={loads.length} items={deliverySummary} /></section>
    </div>
    <section className="panel operational-attention">
      <div className="panel-header"><div><h2>Operational attention</h2><span>Work that should be reviewed before the next handoff</span></div><span>{followUpCount} follow-up{followUpCount === 1 ? '' : 's'}</span></div>
      <div className="attention-grid">
        <AttentionItem label="Delayed loads" value={delayedLoads.length} detail={delayedLoads.length ? 'Review the load plan and carrier status.' : 'No delayed loads in this week.'} action="Open Shipping" onClick={() => onNavigate?.('shipping')} />
        <AttentionItem label="Loaded, awaiting dispatch" value={loadedLoads.length} detail={loadedLoads.length ? 'Confirm dispatch when the load leaves the warehouse.' : 'No loads are awaiting dispatch.'} action="Open Shipping" onClick={() => onNavigate?.('shipping')} />
        <AttentionItem label="Blocked production ZIPs" value={blockedRecords.length} detail={blockedRecords.length ? 'Resolve production blockers before they affect trip readiness.' : 'No production ZIPs are blocked.'} action="Open Production" onClick={() => onNavigate?.('production')} />
        <AttentionItem label="Longest remaining machine run" value={longestRunningMachine ? formatRunHours(longestRunningMachine.estimatedHours) : '—'} detail={longestRunningMachine ? `${longestRunningMachine.machine} has ${longestRunningMachine.runnablePieces.toLocaleString()} pcs remaining.` : 'No runnable production work remains.'} action="Open Production" onClick={() => onNavigate?.('production')} />
      </div>
    </section>
    <section className="panel"><div className="panel-header"><h2>Machine capacity and progress</h2><span>Completion, runnable pieces, and projected run time by machine</span></div><div className="machine-grid">{productionMachines.sort(([a], [b]) => a.localeCompare(b)).map(([machine, items]) => <MachineCard key={machine} machine={machine} items={items} />)}</div></section>
  </section>
}

function ProgressBar({ label, value, total, percent }: { label: string; value: number; total: number; percent: number }) { return <div className="chart-row"><div className="progress-label"><span>{label}</span><strong>{percent}%</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div><div className="metric-detail">{value.toLocaleString()} of {total.toLocaleString()} HH complete</div></div> }
function MachineCard({ machine, items }: { machine: string; items: ProductionRecord[] }) { const capacity = capacityForMachine(machine, items); if (!capacity) return null; const markets = [...new Set(items.filter((item) => item.status !== 'COMPLETE').map((item) => item.market))]; return <div className="machine-item"><div className="progress-label"><span>{machine}</span><strong>{capacity.percentComplete}%</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${capacity.percentComplete}%` }} /></div><div className="metric-detail"><strong>{capacity.runnablePieces.toLocaleString()} pcs runnable</strong>{markets.length ? ` · ${markets.join(', ')}` : ' · Complete'}</div><div className="machine-runtime"><strong>{formatRunHours(capacity.estimatedHours)}</strong></div>{(capacity.blockedPieces > 0 || capacity.skippedPieces > 0) && <div className="machine-exceptions">{capacity.blockedPieces > 0 ? `${capacity.blockedPieces.toLocaleString()} pcs short` : ''}{capacity.blockedPieces > 0 && capacity.skippedPieces > 0 ? ' · ' : ''}{capacity.skippedPieces > 0 ? `${capacity.skippedPieces.toLocaleString()} pcs skipped` : ''}</div>}<div className="metric-detail">{capacity.completePieces.toLocaleString()} of {capacity.totalPieces.toLocaleString()} pcs complete</div></div> }
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <section className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><div className="metric-detail">{detail}</div></section> }
function AttentionItem({ label, value, detail, action, onClick }: { label: string; value: string | number; detail: string; action: string; onClick?: () => void }) { return <section className="attention-item"><span>{label}</span><strong>{value}</strong><p>{detail}</p><button className="text-button" type="button" onClick={onClick}>{action}</button></section> }
function groupBy<T>(items: T[], key: (item: T) => string) { return items.reduce<Record<string, T[]>>((all, item) => ({ ...all, [key(item)]: [...(all[key(item)] ?? []), item] }), {}) }
function progressFor(items: ProductionRecord[]) { const total = items.reduce((sum, item) => sum + item.volume, 0); const complete = items.filter((item) => item.status === 'COMPLETE').reduce((sum, item) => sum + item.volume, 0); return { total, complete, percent: total ? Math.round((complete / total) * 100) : 0 } }
function recordArea(record: { id: string }) { if (record.id.includes('-PROV-BOST-')) return 'PROV-BOST'; if (record.id.includes('-BE-')) return 'BE'; if (record.id.includes('-MMSI-')) return 'MMSI'; return 'FE' }
function statusLabel(status: string) { return status.replaceAll('_', ' ') }
function DeliveryDonut({ total, items }: { total: number; items: { status: string; count: number }[] }) { const colors: Record<string, string> = { NOT_STARTED: '#4e81b8', STAGED: '#98a2b3', LOADED: '#7e71b8', DISPATCHED: '#47836b', DELAYED: '#d97706', CLOSED: '#707b8d' }; const visible = items.filter((item) => item.count > 0); const segments = visible.map((item, index) => { const start = total ? visible.slice(0, index).reduce((sum, current) => sum + current.count, 0) / total * 100 : 0; const end = total ? start + item.count / total * 100 : 0; return `${colors[item.status]} ${start}% ${end}%` }).join(', '); return <div className="donut-chart-layout"><div className="donut-chart" style={{ background: segments ? `conic-gradient(${segments})` : '#eef2f6' }}><span><strong>{total}</strong><small>loads</small></span></div><div className="status-chart-legend">{visible.map(({ status, count }) => <span key={status}><i className={`status-key ${status.toLowerCase()}`} />{statusLabel(status)} <strong>{count}</strong></span>)}</div></div> }
