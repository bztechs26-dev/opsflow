import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Load, OperationalWeek, ProductionRecord } from '../types/operations'

type ProjectionRequirement = { trip: string; atz: string; jobNumber: string; requiredHH: number; sourceName: string }
type Readiness = 'MAPPING_PENDING' | 'NEEDS_REVIEW' | 'NOT_READY' | 'PARTIALLY_READY' | 'READY' | 'BLOCKED' | 'LATE'
type ZipProgress = { requirement: ProjectionRequirement; status: ProductionRecord['status'] | 'MISSING' }
type MachineRunEstimate = { machine: string; rate: number; remainingPieces: number; hours: number }
type TripProjection = { load: Load; requirements: ProjectionRequirement[]; zipProgress: ZipProgress[]; areas: string[]; completeHH: number; requiredHH: number; blocked: number; skipped: number; matched: number; percent: number; readiness: Readiness; remainingHH: number; estimatedHours?: number; machineEstimates: MachineRunEstimate[]; excludedH1Pieces: number; sources: string[] }

const areaLabels: Record<string, string> = { ALL: 'All operations', FRONT_END: 'Front End', BACK_END: 'Back End', SOLO: 'Solo', MMSI: 'MMSI', PROVIDENCE_BOSTON: 'Providence / Boston', UNASSIGNED: 'Other' }

export function ProjectionPage({ weeks, selectedWeekId }: { weeks: OperationalWeek[]; selectedWeekId: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [weekId, setWeekId] = useState(selectedWeekId || weeks[0]?.id || '')
  const [area, setArea] = useState('ALL')
  const [requirements, setRequirements] = useState<ProjectionRequirement[]>([])
  const [message, setMessage] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [expandedTripIds, setExpandedTripIds] = useState<Set<string>>(() => new Set())
  const week = weeks.find((item) => item.id === weekId)

  const selectMappingWorkbook = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; const fileWeek = file ? weekFromFileName(file.name) : undefined
    if (!file || !fileWeek) return
    if (weeks.some((item) => item.id === fileWeek)) { setWeekId(fileWeek); setArea('ALL'); setMessage(`Week ${fileWeek} selected from ${file.name}.`) }
    else setMessage(`This file is for Week ${fileWeek}, which has no uploaded Shipping week yet.`)
  }

  const refreshRequirements = useCallback(async () => {
    if (!weekId) return setRequirements([])
    try {
      const response = await fetch(`/api/projections?week=${encodeURIComponent(weekId)}`)
      if (!response.ok) throw new Error('Projection storage is unavailable. Restart the development server and try again.')
      const data = await response.json() as { requirements: ProjectionRequirement[] }
      setRequirements(data.requirements)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Projection storage is unavailable.') }
  }, [weekId])

  useEffect(() => { const timer = window.setTimeout(() => void refreshRequirements(), 0); return () => window.clearTimeout(timer) }, [refreshRequirements])

  const upload = async () => {
    const file = input.current?.files?.[0]
    if (!file || !weekId) return setMessage('Choose a shipping week and ZIP/TR workbook first.')
    setIsUploading(true); setMessage('')
    try {
      const form = new FormData(); form.set('week', weekId); form.set('file', file)
      const response = await fetch('/api/projections/upload', { method: 'POST', body: form })
      const data = await response.json() as { message?: string }
      if (!response.ok) throw new Error(data.message ?? 'The ZIP/TR workbook could not be stored.')
      setMessage(data.message ?? 'ZIP/TR mappings stored.'); if (input.current) input.current.value = ''
      await refreshRequirements()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The ZIP/TR workbook could not be stored.') } finally { setIsUploading(false) }
  }

  const projections = useMemo(() => week ? deriveProjections([...week.loads, ...unlinkedMappingLoads(week.loads, requirements)], weeks.flatMap((item) => item.productionRecords), requirements) : [], [week, weeks, requirements])
  const availableAreas = useMemo(() => [...new Set(projections.flatMap((projection) => projection.areas))], [projections])
  const visible = projections.filter((projection) => area === 'ALL' || projection.areas.includes(area))
  const ready = visible.filter((projection) => projection.readiness === 'READY').length
  const inProgress = visible.filter((projection) => projection.readiness === 'PARTIALLY_READY').length
  const mapped = visible.filter((projection) => projection.requirements.length > 0).length
  const sourceTrips = new Set(requirements.map((item) => normalizeTrip(item.trip)))
  const toggleTripDetails = (tripId: string) => setExpandedTripIds((current) => { const next = new Set(current); if (next.has(tripId)) next.delete(tripId); else next.add(tripId); return next })

  return <section className="page projection-page">
    <div className="page-heading"><div><h1>Projection</h1><p>Live production readiness for Shipping trips, based on ZIP/TR mappings, job number, and required households.</p></div></div>
    <section className="panel projection-upload"><div><span className="metric-label">ZIP/TR mapping intake</span><h2>Upload a trip-to-production workbook</h2><p>The file name determines its operational week and market. ZIP is read from column A and TR from column C.</p></div><div className="projection-form"><label>Shipping week<select className="week-select" value={weekId} onChange={(event) => { setWeekId(event.target.value); setArea('ALL') }} disabled={!weeks.length}>{weeks.length ? weeks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>) : <option value="">No uploaded weeks</option>}</select></label><label className="projection-file">ZIP/TR workbook<input ref={input} type="file" accept=".xlsx" onChange={selectMappingWorkbook} /></label><button className="primary-button" type="button" onClick={() => void upload()} disabled={isUploading || !weekId}>{isUploading ? 'Importing...' : 'Import ZIP/TR mappings'}</button></div>{message && <p className="projection-message">{message}</p>}</section>
    {!week ? <section className="panel empty-page"><h2>No shipping week selected</h2><p>Upload a Bulk Plan first, then select its shipping week here.</p></section> : <><nav className="production-subnav projection-tabs" aria-label="Projection operations"><button className={area === 'ALL' ? 'active' : ''} onClick={() => setArea('ALL')}>All trips <span>{projections.length}</span></button>{availableAreas.map((item) => <button className={area === item ? 'active' : ''} key={item} onClick={() => setArea(item)}>{areaLabels[item] ?? item} <span>{projections.filter((projection) => projection.areas.includes(item)).length}</span></button>)}</nav>
    <div className="metric-grid projection-metrics"><Metric label="Shipping trips" value={String(visible.length)} detail={`${areaLabels[area] ?? area} for ${week?.label ?? 'selected week'}`}/><Metric label="Production ready" value={String(ready)} detail="All mapped HH complete"/><Metric label="In progress" value={String(inProgress)} detail="Some mapped HH complete"/><Metric label="ZIP/TR coverage" value={`${mapped} / ${visible.length}`} detail={`${sourceTrips.size} mapped trips received; remaining loads await ZIP/TR workbooks`}/></div>
    <section className="panel projection-table"><div className="panel-header"><div><h2>Trip production projection</h2><span>Use the plus sign beside a trip to review every ZIP and its live production status.</span></div><span>{visible.length} visible trips</span></div><div className="table-wrap"><table className="data-table projection-trip-table"><thead><tr><th>Trip / load</th><th>Required ZIPs</th><th>Production progress</th><th>Estimated run time</th><th>Readiness</th></tr></thead>{visible.map((projection) => { const expanded = expandedTripIds.has(projection.load.id); return <tbody key={projection.load.id}><tr><td><button className="trip-details-toggle" type="button" onClick={() => toggleTripDetails(projection.load.id)} aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} ZIP details for trip ${projection.load.number}`}><span>{expanded ? '-' : '+'}</span>{projection.load.number}</button></td><td>{projection.requirements.length || '-'}</td><td><div className="projection-progress"><div className="progress-label"><span>{projection.requirements.length ? `${projection.completeHH.toLocaleString()} of ${projection.requiredHH.toLocaleString()} HH complete` : 'ZIP/TR mapping required'}</span><strong>{projection.requirements.length ? `${projection.percent}%` : '-'}</strong></div><div className="progress-track"><div className={`progress-fill ${projection.readiness === 'BLOCKED' || projection.readiness === 'LATE' ? 'projection-blocked' : ''}`} style={{ width: `${projection.percent}%` }} /></div><small>{projection.requirements.length ? `${projection.remainingHH.toLocaleString()} HH remaining / ${projection.matched} of ${projection.requirements.length} requirements matched` : 'Awaiting the ZIP/TR workbook that contains this trip.'}</small></div></td><td><RunTimeEstimate projection={projection}/></td><td><ReadinessBadge readiness={projection.readiness}/></td></tr>{expanded && <tr className="trip-details-row"><td colSpan={5}><div className="trip-details"><div><strong>ZIP details for trip {projection.load.number}</strong><span>{projection.zipProgress.length} mapped ZIPs</span></div><table className="data-table zip-details-table"><thead><tr><th>ZIP / ATZ</th><th>Job number</th><th>Required HH</th><th>Production status</th></tr></thead><tbody>{projection.zipProgress.map((zip) => <tr key={`${zip.requirement.atz}-${zip.requirement.jobNumber}`}><td>{zip.requirement.atz}</td><td>{zip.requirement.jobNumber || '-'}</td><td>{zip.requirement.requiredHH.toLocaleString()}</td><td><ZipStatusBadge status={zip.status}/></td></tr>)}</tbody></table><MachineEstimatePanel projection={projection}/></div></td></tr>}</tbody>})}</table></div></section></>}</section>

  return <section className="page projection-page">
    <div className="page-heading"><div><h1>Projection</h1><p>Live production readiness for Shipping trips, based on ZIP/TR mappings, job number, and required households.</p></div></div>
    <section className="panel projection-upload"><div><span className="metric-label">ZIP/TR mapping intake</span><h2>Upload a trip-to-production workbook</h2><p>The file name determines its operational week and market. For example, “BE Wk 36.xlsx” is imported into Back End for Week 36. ZIP is read from column A and TR from column C.</p></div><div className="projection-form"><label>Shipping week<select className="week-select" value={weekId} onChange={(event) => { setWeekId(event.target.value); setArea('ALL') }} disabled={!weeks.length}>{weeks.length ? weeks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>) : <option value="">No uploaded weeks</option>}</select></label><label className="projection-file">ZIP/TR workbook<input ref={input} type="file" accept=".xlsx" onChange={selectMappingWorkbook} /></label><button className="primary-button" type="button" onClick={() => void upload()} disabled={isUploading || !weekId}>{isUploading ? 'Importing…' : 'Import ZIP/TR mappings'}</button></div>{message && <p className="projection-message">{message}</p>}</section>
    {!week ? <section className="panel empty-page"><h2>No shipping week selected</h2><p>Upload a Bulk Plan first, then select its shipping week here.</p></section> : <><nav className="production-subnav projection-tabs" aria-label="Projection operations"><button className={area === 'ALL' ? 'active' : ''} onClick={() => setArea('ALL')}>All trips <span>{projections.length}</span></button>{availableAreas.map((item) => <button className={area === item ? 'active' : ''} key={item} onClick={() => setArea(item)}>{areaLabels[item] ?? item} <span>{projections.filter((projection) => projection.areas.includes(item)).length}</span></button>)}</nav>
    <div className="metric-grid projection-metrics"><Metric label="Shipping trips" value={String(visible.length)} detail={`${areaLabels[area] ?? area} for ${week?.label ?? 'selected week'}`}/><Metric label="Production ready" value={String(ready)} detail="All mapped HH complete"/><Metric label="In progress" value={String(inProgress)} detail="Some mapped HH complete"/><Metric label="ZIP/TR coverage" value={`${mapped} / ${visible.length}`} detail={`${sourceTrips.size} mapped trips received; remaining loads await ZIP/TR workbooks`}/></div>
    <section className="panel projection-table"><div className="panel-header"><div><h2>Trip production projection</h2><span>Production changes recalculate these trip bars immediately. A trip without a ZIP/TR mapping is never treated as not started.</span></div><span>{visible.length} visible trips</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Trip / load</th><th>Carrier</th><th>Destination</th><th>Required ATZs</th><th>Production progress</th><th>Readiness</th></tr></thead><tbody>{visible.map((projection) => <tr key={projection.load.id}><td>{projection.load.number}</td><td>{projection.load.carrier}</td><td>{projection.load.destination}</td><td>{projection.requirements.length || '—'}</td><td><div className="projection-progress"><div className="progress-label"><span>{projection.requirements.length ? `${projection.completeHH.toLocaleString()} of ${projection.requiredHH.toLocaleString()} HH complete` : 'ZIP/TR mapping required'}</span><strong>{projection.requirements.length ? `${projection.percent}%` : '—'}</strong></div><div className="progress-track"><div className={`progress-fill ${projection.readiness === 'BLOCKED' ? 'projection-blocked' : ''}`} style={{ width: `${projection.percent}%` }} /></div><small>{projection.requirements.length ? `${projection.remainingHH.toLocaleString()} HH remaining · ${projection.matched} of ${projection.requirements.length} requirements matched${projection.sources.length ? ` · ${projection.sources.join(', ')}` : ''}` : 'Awaiting the ZIP/TR workbook that contains this trip.'}</small></div></td><td><ReadinessBadge readiness={projection.readiness}/></td></tr>)}</tbody></table></div></section></>}</section>
}

function deriveProjections(loads: Load[], production: ProductionRecord[], requirements: ProjectionRequirement[]) {
  const byJobAndAtz = new Map<string, ProductionRecord[]>()
  const byAtz = new Map<string, ProductionRecord[]>()
  for (const record of production) {
    const atz = normalizeAtz(record.zip); const jobKey = record.jobNumber ? `${record.jobNumber}|${atz}` : ''
    if (jobKey) byJobAndAtz.set(jobKey, [...(byJobAndAtz.get(jobKey) ?? []), record])
    byAtz.set(atz, [...(byAtz.get(atz) ?? []), record])
  }
  const byTrip = new Map<string, ProjectionRequirement[]>()
  for (const requirement of requirements) { const key = normalizeTrip(requirement.trip); byTrip.set(key, [...(byTrip.get(key) ?? []), requirement]) }
  return loads.map((load): TripProjection => {
    const tripRequirements = byTrip.get(normalizeTrip(load.number)) ?? []
    const mappedAreas = [...new Set(tripRequirements.map((requirement) => areaFromFileName(requirement.sourceName)))]
    const areas = mappedAreas.length ? mappedAreas : [load.area ?? 'UNASSIGNED']
    if (!tripRequirements.length) return { load, requirements: [], zipProgress: [], areas, completeHH: 0, requiredHH: 0, blocked: 0, skipped: 0, matched: 0, percent: 0, readiness: 'MAPPING_PENDING', remainingHH: 0, machineEstimates: [], excludedH1Pieces: 0, sources: [] }
    const matches = tripRequirements.map((requirement) => {
      const exact = byJobAndAtz.get(`${requirement.jobNumber}|${normalizeAtz(requirement.atz)}`) ?? []
      const fallback = byAtz.get(normalizeAtz(requirement.atz)) ?? []
      return bestProductionMatch(exact.length ? exact : fallback)
    })
    const matched = matches.filter((record): record is ProductionRecord => Boolean(record))
    const zipProgress: ZipProgress[] = tripRequirements.map((requirement, index) => ({ requirement, status: matches[index]?.status ?? 'MISSING' }))
    const completeHH = tripRequirements.reduce((total, requirement, index) => total + (matches[index]?.status === 'COMPLETE' ? requirement.requiredHH : 0), 0)
    const blocked = matched.filter((record) => record.status === 'BLOCKED').length
    const skipped = matched.filter((record) => record.status === 'SKIPPED').length
    const requiredHH = tripRequirements.reduce((total, requirement) => total + requirement.requiredHH, 0)
    const unmatched = tripRequirements.length - matched.length
    const machinePieces = new Map<string, { rate: number; pieces: number }>(); let excludedH1Pieces = 0
    for (const [index, record] of matches.entries()) { if (!record || record.status === 'COMPLETE' || record.status === 'BLOCKED' || record.status === 'SKIPPED') continue; const rate = machineRate(record.machine); if (!rate) { excludedH1Pieces += tripRequirements[index].requiredHH; continue }; const current = machinePieces.get(record.machine) ?? { rate, pieces: 0 }; current.pieces += tripRequirements[index].requiredHH; machinePieces.set(record.machine, current) }
    const machineEstimates = [...machinePieces.entries()].map(([machine, value]) => ({ machine, rate: value.rate, remainingPieces: value.pieces, hours: value.pieces / value.rate })).sort((a, b) => b.hours - a.hours)
    const estimatedHours = machineEstimates.length ? Math.max(...machineEstimates.map((item) => item.hours)) : undefined
    const readiness: Readiness = blocked ? 'BLOCKED' : skipped ? 'LATE' : unmatched ? 'NEEDS_REVIEW' : completeHH === requiredHH ? 'READY' : completeHH ? 'PARTIALLY_READY' : 'NOT_READY'
    const sources = [...new Set(matched.map((record) => `${record.week} · ${record.market}`))]
    return { load, requirements: tripRequirements, zipProgress, areas, completeHH, requiredHH, blocked, skipped, matched: matched.length, percent: requiredHH ? Math.round((completeHH / requiredHH) * 100) : 0, readiness, remainingHH: requiredHH - completeHH, estimatedHours, machineEstimates, excludedH1Pieces, sources }
  })
}

function unlinkedMappingLoads(loads: Load[], requirements: ProjectionRequirement[]): Load[] {
  const shippingTrips = new Set(loads.map((load) => normalizeTrip(load.number)))
  const requirementsByTrip = new Map<string, ProjectionRequirement[]>()
  for (const requirement of requirements) {
    const trip = normalizeTrip(requirement.trip)
    requirementsByTrip.set(trip, [...(requirementsByTrip.get(trip) ?? []), requirement])
  }
  return [...requirementsByTrip.entries()].filter(([trip]) => !shippingTrips.has(trip)).map(([trip, tripRequirements]): Load => {
    const areas = [...new Set(tripRequirements.map((requirement) => areaFromFileName(requirement.sourceName)))]
    return { id: `mapping-${trip}`, number: trip, area: areas[0], carrier: '-', destination: 'Shipping load not found for this week', equipment: '-', weight: '-', stops: 0, pickup: '-', status: 'PLANNED' }
  })
}

function normalizeTrip(value: string) { return value.replace(/\D/g, '').replace(/^0+/, '') }
function normalizeAtz(value: string) { return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') }
function machineRate(machine: string) { const normalized = machine.trim().toUpperCase(); if (/^A\d+/.test(normalized) && normalized !== 'A05') return 10_000; if (/^(?:FERAG|F)\s*0?\d+/.test(normalized)) return 20_000; return 0 }
function bestProductionMatch(records: ProductionRecord[]) { const priority: Record<ProductionRecord['status'], number> = { COMPLETE: 5, IN_PROGRESS: 4, NOT_STARTED: 3, BLOCKED: 2, SKIPPED: 1 }; return records.reduce<ProductionRecord | undefined>((best, record) => !best || priority[record.status] > priority[best.status] ? record : best, undefined) }
function weekFromFileName(fileName: string) { return fileName.match(/\b(?:wk|week)[\s_-]*(\d{1,2})\b/i)?.[1] }
function areaFromFileName(fileName: string) { const name = fileName.toUpperCase(); if (/\b(?:BE|BACK[ _-]?END)\b/.test(name)) return 'BACK_END'; if (/\b(?:FE|FRONT[ _-]?END)\b/.test(name)) return 'FRONT_END'; if (/\bMMSI\b/.test(name)) return 'MMSI'; if (/\b(?:BOST|BOS|PROV|HART)\b/.test(name)) return 'PROVIDENCE_BOSTON'; return 'UNASSIGNED' }
function ReadinessBadge({ readiness }: { readiness: Readiness }) { const label = readiness === 'MAPPING_PENDING' ? 'MAPPING PENDING' : readiness === 'NEEDS_REVIEW' ? 'ZIPs MISSING' : readiness === 'BLOCKED' ? 'ZIPs SHORT' : readiness.replaceAll('_', ' '); return <span className={`status projection-${readiness.toLowerCase()}`}>{label}</span> }
function ZipStatusBadge({ status }: { status: ZipProgress['status'] }) { const label = status === 'MISSING' ? 'ZIP MISSING' : status === 'BLOCKED' ? 'ZIP SHORT' : status === 'SKIPPED' ? 'SKIPPED / LATE' : status.replaceAll('_', ' '); return <span className={`status zip-status-${status.toLowerCase()}`}>{label}</span> }
function RunTimeEstimate({ projection }: { projection: TripProjection }) { if (projection.skipped) return <span className="run-time-alert">Late: {projection.skipped} skipped ZIP{projection.skipped === 1 ? '' : 's'}</span>; if (projection.blocked) return <span className="run-time-alert">Action needed</span>; if (projection.estimatedHours === undefined) return <span className="run-time-muted">No active machine work</span>; return <strong className="run-time-value">{formatHours(projection.estimatedHours)}<small>run time remaining</small></strong> }
function MachineEstimatePanel({ projection }: { projection: TripProjection }) { return <section className="machine-estimate-panel"><div><strong>Machine run-time estimate</strong><span>Alpha and Ferag machines run in parallel.</span></div>{projection.machineEstimates.length ? <div className="machine-estimate-grid">{projection.machineEstimates.map((estimate) => <div key={estimate.machine}><strong>{estimate.machine}</strong><span>{estimate.remainingPieces.toLocaleString()} pcs remaining</span><b>{formatHours(estimate.hours)}</b></div>)}</div> : <p>No active runnable ZIPs are assigned to a production machine.</p>}{projection.excludedH1Pieces > 0 && <p>H1 review copies ({projection.excludedH1Pieces.toLocaleString()} pcs) are excluded from the machine estimate.</p>}{projection.skipped > 0 && <p className="run-time-alert">This trip is late until its skipped ZIPs are resolved. Skipped pieces are not counted as completed or as runnable machine work.</p>}</section> }
function formatHours(hours: number) { return `${hours.toFixed(hours < 10 ? 1 : 0)} hr${Math.round(hours) === 1 ? '' : 's'}` }
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <section className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><div className="metric-detail">{detail}</div></section> }
