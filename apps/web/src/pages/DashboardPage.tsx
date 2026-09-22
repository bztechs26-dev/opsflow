import { useMemo, useState } from 'react'
import type { Load, ProductionRecord } from '../types/operations'
import { capacityForMachine, formatRunHours } from '../data/machineCapacity'

interface Props {
  loads: Load[]
  records: ProductionRecord[]
}

const areaLabels: Record<string, string> = { FE: 'Front End', BE: 'Back End', 'PROV-BOST': 'Providence / Boston', MMSI: 'MMSI' }
const areas = ['ALL', 'FE', 'BE', 'PROV-BOST', 'MMSI']
const shippingAreaForProductionArea: Record<string, string> = { FE: 'FRONT_END', BE: 'BACK_END', 'PROV-BOST': 'PROVIDENCE_BOSTON', MMSI: 'MMSI' }

export function DashboardPage({ loads, records }: Props) {
  const [area, setArea] = useState('ALL')
  const areaCounts = useMemo(() => Object.fromEntries(areas.filter((key) => key !== 'ALL').map((key) => [key, records.filter((record) => recordArea(record) === key).length])), [records])
  const visibleRecords = useMemo(() => area === 'ALL' ? records : records.filter((record) => recordArea(record) === area), [area, records])
  const totalHH = visibleRecords.reduce((sum, record) => sum + record.volume, 0)
  const completeHH = visibleRecords.filter(isProcessed).reduce((sum, record) => sum + record.volume, 0)
  const percent = totalHH ? Math.round((completeHH / totalHH) * 100) : 0
  const productionMachines = Object.entries(groupBy(visibleRecords, (record) => record.machine)).filter(([machine, items]) => Boolean(capacityForMachine(machine, items)))
  const areaProgress = area === 'ALL'
    ? areas.filter((key) => key !== 'ALL').map((key) => ({ ...progressFor(records.filter((record) => recordArea(record) === key)), key }))
    : [{ ...progressFor(visibleRecords), key: area }]
  const visibleLoads = area === 'ALL' ? loads : loads.filter((load) => load.area === shippingAreaForProductionArea[area])
  const deliveryStatuses = ['NOT_STARTED', 'STAGED', 'LOADED', 'DISPATCHED', 'DELAYED', 'CLOSED'] as const
  const deliverySummary = deliveryStatuses.map((status) => ({ status, count: visibleLoads.filter((load) => load.status === status).length }))
  const areaLabel = area === 'ALL' ? 'All operations' : areaLabels[area]

  return <section className="page">
    <div className="page-heading"><div><h1>Operations dashboard</h1><p>Weekly readiness, household progress, active markets, and machine capacity.</p></div></div>
    <div className="area-tabs dashboard-area-tabs" aria-label="Production area">
      {areas.map((key) => <button key={key} type="button" className={area === key ? 'area-tab active' : 'area-tab'} onClick={() => setArea(key)}>
        {key === 'ALL' ? 'All operations' : areaLabels[key]}<span>{key === 'ALL' ? records.length : areaCounts[key]}</span>
      </button>)}
    </div>
    <div className="metric-grid">
      <Metric label="Total loads" value={String(visibleLoads.length)} detail={`${areaLabel} loads from the weekly Bulk Plan`} />
      <Metric label={`${areaLabel} completion`} value={`${percent}%`} detail={`${completeHH.toLocaleString()} HH complete · ${visibleRecords.filter(isProcessed).length} ZIPs finished`} />
      <Metric label="HH remaining" value={(totalHH - completeHH).toLocaleString()} detail="Production quantity still running" />
      <Metric label="Machines" value={String(productionMachines.length)} detail={`${areaLabel} production machines; H1 review copies excluded`} />
    </div>
    <div className="dashboard-grid">
      <section className="panel chart-panel"><div className="panel-header"><h2>{area === 'ALL' ? 'Production completion by area' : `${areaLabel} production completion`}</h2><span>Completed household quantity</span></div><div className="bar-chart">{areaProgress.map(({ key, complete, total, percent: areaPercent }) => <ProgressBar key={key} label={areaLabels[key] ?? key} value={complete} total={total} percent={areaPercent} />)}</div></section>
      <section className="panel chart-panel"><div className="panel-header"><h2>Shipping delivery state</h2><span>All operations · {loads.length} planned loads</span></div><DeliveryDonut total={loads.length} items={deliverySummary} /></section>
    </div>
    <section className="panel"><div className="panel-header"><h2>{areaLabel} machine capacity and progress</h2><span>Completion, runnable pieces, and projected run time by machine</span></div><div className="machine-grid">{productionMachines.sort(([a], [b]) => a.localeCompare(b)).map(([machine, items]) => <MachineCard key={machine} machine={machine} items={items} />)}</div>{!productionMachines.length && <p className="empty-area-message">No production records have been uploaded for {areaLabel} this week.</p>}</section>
  </section>
}

function ProgressBar({ label, value, total, percent }: { label: string; value: number; total: number; percent: number }) { return <div className="chart-row"><div className="progress-label"><span>{label}</span><strong>{percent}%</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div><div className="metric-detail">{value.toLocaleString()} of {total.toLocaleString()} HH complete</div></div> }
function MachineCard({ machine, items }: { machine: string; items: ProductionRecord[] }) { const capacity = capacityForMachine(machine, items); if (!capacity) return null; const markets = [...new Set(items.filter((item) => !isProcessed(item)).map((item) => item.market))]; return <div className="machine-item"><div className="progress-label"><span>{machine}</span><strong>{capacity.percentComplete}%</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${capacity.percentComplete}%` }} /></div><div className="metric-detail"><strong>{capacity.runnablePieces.toLocaleString()} pcs runnable</strong>{markets.length ? ` · ${markets.join(', ')}` : ' · Complete'}</div><div className="machine-runtime"><strong>{formatRunHours(capacity.estimatedHours)}</strong></div>{(capacity.blockedPieces > 0 || capacity.skippedPieces > 0) && <div className="machine-exceptions">{capacity.blockedPieces > 0 ? `${capacity.blockedPieces.toLocaleString()} pcs short` : ''}{capacity.blockedPieces > 0 && capacity.skippedPieces > 0 ? ' · ' : ''}{capacity.skippedPieces > 0 ? `${capacity.skippedPieces.toLocaleString()} pcs skipped` : ''}</div>}<div className="metric-detail">{capacity.completePieces.toLocaleString()} of {capacity.totalPieces.toLocaleString()} pcs complete</div></div> }
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <section className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><div className="metric-detail">{detail}</div></section> }
function groupBy<T>(items: T[], key: (item: T) => string) { return items.reduce<Record<string, T[]>>((all, item) => ({ ...all, [key(item)]: [...(all[key(item)] ?? []), item] }), {}) }
function progressFor(items: ProductionRecord[]) { const total = items.reduce((sum, item) => sum + item.volume, 0); const complete = items.filter(isProcessed).reduce((sum, item) => sum + item.volume, 0); return { total, complete, percent: total ? Math.round((complete / total) * 100) : 0 } }
function recordArea(record: ProductionRecord) { return record.sourceArea ?? (record.id.includes('-PROV-BOST-') ? 'PROV-BOST' : record.id.includes('-BE-') ? 'BE' : record.id.includes('-MMSI-') ? 'MMSI' : 'FE') }
function isProcessed(record: ProductionRecord) { return record.status === 'COMPLETE' || record.status === 'BLOCKED' }
function statusLabel(status: string) { return status.replaceAll('_', ' ') }
function DeliveryDonut({ total, items }: { total: number; items: { status: string; count: number }[] }) { const colors: Record<string, string> = { NOT_STARTED: '#4e81b8', STAGED: '#98a2b3', LOADED: '#7e71b8', DISPATCHED: '#47836b', DELAYED: '#d97706', CLOSED: '#707b8d' }; const visible = items.filter((item) => item.count > 0); const segments = visible.map((item, index) => { const start = total ? visible.slice(0, index).reduce((sum, current) => sum + current.count, 0) / total * 100 : 0; const end = total ? start + item.count / total * 100 : 0; return `${colors[item.status]} ${start}% ${end}%` }).join(', '); return <div className="donut-chart-layout"><div className="donut-chart" style={{ background: segments ? `conic-gradient(${segments})` : '#eef2f6' }}><span><strong>{total}</strong><small>loads</small></span></div><div className="status-chart-legend">{visible.map(({ status, count }) => <span key={status}><i className={`status-key ${status.toLowerCase()}`} />{statusLabel(status)} <strong>{count}</strong></span>)}</div></div> }