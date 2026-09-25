import { useMemo, useState } from 'react'
import type { ProductionRecord, QueueMachinePlan, QueuePlan } from '../types/operations'

type Props = { records: ProductionRecord[]; plan?: QueuePlan; onChange: (plan: QueuePlan) => void }

export function CapacityStaffingPlanner({ records, plan, onChange }: Props) {
  const machines = useMemo(() => [...new Set(records.map((record) => record.machine))].sort(), [records])
  const [machine, setMachine] = useState(machines[0] ?? '')
  const [draft, setDraft] = useState<QueuePlan>()
  if (!plan) return <section className="panel staffing-setup"><div><h2>Capacity & staffing setup</h2><p>Create one shared plan, then set the shift volume, LHPT goal, and available crew for each production machine.</p></div><button className="primary-button" type="button" onClick={() => onChange({ shiftHours: 9.5, machines: machines.map((name) => ({ machine: name, expectedPackages: 0, lhptGoal: 0, availableCrew: 0 })) })}>Initialize plan</button></section>
  const savedPlan = plan ?? { shiftHours: 9.5, machines: [] }
  const source = draft ?? savedPlan
  // Older plans may not contain a recently imported machine. Display it with
  // safe zero assumptions and add it when the supervisor saves the plan.
  const workingPlan: QueuePlan = {
    ...source,
    machines: machines.map((name) => source.machines.find((item) => sameMachine(item.machine, name)) ?? { machine: name, expectedPackages: 0, lhptGoal: 0, availableCrew: 0 }),
  }
  const selectedMachine = machines.includes(machine) ? machine : machines[0] ?? ''
  const selected = workingPlan.machines.find((item) => sameMachine(item.machine, selectedMachine))
  if (!selected) return <section className="panel empty-page"><h2>No production machines available</h2><p>Import a Production QA workbook before creating a capacity plan.</p></section>

  const changePlan = (next: QueuePlan) => setDraft(next)
  const updateMachine = (field: keyof Pick<QueueMachinePlan, 'expectedPackages' | 'lhptGoal' | 'availableCrew'>, value: number) => changePlan({ ...workingPlan, machines: workingPlan.machines.map((item) => sameMachine(item.machine, selectedMachine) ? { ...item, [field]: value } : item) })
  const selectedMetrics = calculate(records, selectedMachine, selected, workingPlan.shiftHours)

  return <section className="capacity-staffing-page">
    <section className="panel capacity-planner">
      <div className="panel-header"><div><h2>Capacity & staffing plan</h2><span>Set the shift assumptions for one machine, then review its live workload and staffing need.</span></div>{draft && <div className="assumption-actions"><button className="secondary-button" type="button" onClick={() => setDraft(undefined)}>Cancel</button><button className="primary-button" type="button" onClick={() => { onChange(workingPlan); setDraft(undefined) }}>Save plan</button></div>}</div>
      <div className="capacity-inputs">
        <label>Machine<select value={selectedMachine} onChange={(event) => setMachine(event.target.value)}>{machines.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Shift hours<input type="number" min="1" max="24" step="0.5" value={workingPlan.shiftHours} onChange={(event) => changePlan({ ...workingPlan, shiftHours: Number(event.target.value) })}/><small>Total operating time for this shift.</small></label>
        <label>Planned shift volume<input type="number" min="0" step="1000" value={selected.expectedPackages || ''} placeholder="e.g. 85000" onChange={(event) => updateMachine('expectedPackages', Number(event.target.value))}/><small>Maximum pieces this machine is planned to process.</small></label>
        <label>LHPT goal<input type="number" min="0" step="0.001" value={selected.lhptGoal || ''} placeholder="e.g. 0.075" onChange={(event) => updateMachine('lhptGoal', Number(event.target.value))}/><small>Labor hours required per 1,000 pieces.</small></label>
        <label>Available crew<input type="number" min="0" step="0.5" value={selected.availableCrew || ''} placeholder="Enter crew" onChange={(event) => updateMachine('availableCrew', Number(event.target.value))}/><small>People assigned to this machine and shift.</small></label>
      </div>
    </section>

    <section className="panel capacity-summary">
      <div className="panel-header"><div><h2>{selectedMachine} shift outlook</h2><span>Uses only NOT STARTED ZIPs, in the production queue order.</span></div></div>
      <div className="capacity-metrics">
        <Metric label="Planned shift volume" value={format(selected.expectedPackages)} detail="maximum pieces" />
        <Metric label="Queued volume" value={format(selectedMetrics.queuedVolume)} detail={`${selectedMetrics.zips} ZIPs fit in the plan`} />
        <Metric label="Expected throughput" value={format(selectedMetrics.pph)} detail={`${workingPlan.shiftHours} shift hours`} />
        <Metric label="Projected pieces" value={format(selectedMetrics.projectedPieces)} detail="adjusted using I.R." />
        <Metric label="Crew required" value={selectedMetrics.crewRequired.toFixed(1)} detail="people for this shift" />
        <Metric label="Staffing balance" value={`${selectedMetrics.balance >= 0 ? '+' : ''}${selectedMetrics.balance.toFixed(1)}`} detail={selectedMetrics.balance >= 0 ? 'crew available after plan' : 'additional crew needed'} tone={selectedMetrics.balance < 0 ? 'alert' : undefined} />
        <Metric label="Coverage" value={`${selectedMetrics.coverage}%`} detail="available crew ÷ crew required" tone={selectedMetrics.coverage < 100 ? 'alert' : undefined} />
      </div>
      <p className="capacity-rule">The next ZIP is not included if it would exceed the planned shift volume. Crew required = projected pieces × LHPT ÷ 1,000 ÷ shift hours.</p>
    </section>

    <section className="panel capacity-overview"><div className="panel-header"><div><h2>All machines at a glance</h2><span>Review saved assumptions and the current eligible queue before selecting another machine to edit.</span></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Machine</th><th>Shift volume</th><th>LHPT</th><th>Available crew</th><th>Queued volume</th><th>Crew required</th><th>Balance</th></tr></thead><tbody>{workingPlan.machines.map((item) => { const result = calculate(records, item.machine, item, workingPlan.shiftHours); return <tr key={item.machine}><td><button className="capacity-machine-link" type="button" onClick={() => setMachine(item.machine)}>{item.machine}</button></td><td>{format(item.expectedPackages)}</td><td>{item.lhptGoal.toFixed(3)}</td><td>{item.availableCrew ?? 0}</td><td>{format(result.queuedVolume)}</td><td>{result.crewRequired.toFixed(1)}</td><td className={result.balance < 0 ? 'capacity-negative' : ''}>{result.balance >= 0 ? '+' : ''}{result.balance.toFixed(1)}</td></tr> })}</tbody></table></div></section>
  </section>
}

function calculate(records: ProductionRecord[], machine: string, assumptions: QueueMachinePlan, shiftHours: number) {
  const eligible = records.filter((record) => sameMachine(record.machine, machine) && record.status === 'NOT_STARTED').sort((left, right) => left.queueOrder - right.queueOrder)
  let queuedVolume = 0
  let projectedPieces = 0
  let zips = 0
  for (const record of eligible) {
    if (queuedVolume + record.volume > assumptions.expectedPackages) break
    queuedVolume += record.volume
    projectedPieces += record.volume * irMultiplier(record.ir)
    zips += 1
  }
  const crewRequired = shiftHours > 0 ? projectedPieces * assumptions.lhptGoal / 1000 / shiftHours : 0
  const available = assumptions.availableCrew ?? 0
  return { queuedVolume, projectedPieces, zips, pph: shiftHours > 0 ? Math.round(assumptions.expectedPackages / shiftHours) : 0, crewRequired, balance: available - crewRequired, coverage: crewRequired > 0 ? Math.min(100, Math.round(available / crewRequired * 100)) : 0 }
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'alert' }) { return <div className={tone ? `capacity-metric ${tone}` : 'capacity-metric'}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div> }
function irMultiplier(ir: string) { const match = ir.match(/^(\d+)\s*:/); return match ? Number(match[1]) + 1 : 0 }
function sameMachine(left: string, right: string) { return canonical(left) === canonical(right) }
function canonical(value: string) { return value.trim().toUpperCase().replace(/^FERAG\s*/, 'F').replace(/^([A-Z]+)0+(\d+)$/, '$1$2') }
function format(value: number) { return value.toLocaleString() }
