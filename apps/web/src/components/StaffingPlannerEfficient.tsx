import { useState } from 'react'
import type { ProductionRecord, QueuePlan } from '../types/operations'

export function StaffingPlannerEfficient({ records, plan, onChange }: { records: ProductionRecord[]; plan?: QueuePlan; onChange: (plan: QueuePlan) => void }) {
  const machines = [...new Set(records.map((record) => record.machine))].sort()
  const [machine, setMachine] = useState(machines[0] ?? '')
  const [draft, setDraft] = useState<QueuePlan>()

  if (!plan) return <section className="panel staffing-setup"><div><h2>Capacity & staffing setup</h2><p>Initialize the plan to enter shift hours, package capacity, LHPT goals, and available crew for each machine.</p></div><button className="primary-button" type="button" onClick={() => onChange({ shiftHours: 9.5, machines: machines.map((name) => ({ machine: name, expectedPackages: 0, lhptGoal: 0 })) })}>Initialize capacity plan</button></section>

  const workingPlan = draft ?? plan
  const row = workingPlan.machines.find((item) => sameMachine(item.machine, machine))
  if (!row) return null
  const update = (key: 'expectedPackages' | 'lhptGoal' | 'availableCrew', value: number) => setDraft({ ...workingPlan, machines: workingPlan.machines.map((item) => sameMachine(item.machine, machine) ? { ...item, [key]: value } : item) })
  const eligible = records.filter((record) => sameMachine(record.machine, machine) && record.status === 'NOT_STARTED').sort((a, b) => a.queueOrder - b.queueOrder)
  let packages = 0
  let pieces = 0
  for (const record of eligible) {
    if (packages + record.volume > row.expectedPackages) break
    packages += record.volume
    pieces += record.volume * multiplier(record.ir)
  }
  const required = pieces * row.lhptGoal / 1000 / workingPlan.shiftHours
  const available = row.availableCrew ?? 0
  const coverage = required ? Math.min(100, Math.round(available / required * 100)) : 0

  return <section className="panel staffing-planner"><div className="panel-header"><div><h2>Live staffing projection</h2><span>Adjust assumptions to model today&apos;s operating plan.</span></div>{draft && <div className="assumption-actions"><button className="secondary-button" type="button" onClick={() => setDraft(undefined)}>Cancel</button><button className="primary-button" type="button" onClick={() => { onChange(draft); setDraft(undefined) }}>Save plan</button></div>}</div><div className="planner-inputs"><label>Machine<select value={machine} onChange={(event) => setMachine(event.target.value)}>{machines.filter((name) => workingPlan.machines.some((item) => sameMachine(item.machine, name))).map((name) => <option key={name}>{name}</option>)}</select></label><label>Shift hours<input type="number" min="1" step="0.5" value={workingPlan.shiftHours} onChange={(event) => setDraft({ ...workingPlan, shiftHours: Number(event.target.value) })}/></label><label>Package capacity<input type="number" min="0" step="1000" value={row.expectedPackages} onChange={(event) => update('expectedPackages', Number(event.target.value))}/></label><label>LHPT goal<input type="number" min="0" step="0.001" value={row.lhptGoal} onChange={(event) => update('lhptGoal', Number(event.target.value))}/></label><label>Available crew<input type="number" min="0" step="0.5" value={available || ''} placeholder="Enter crew" onChange={(event) => update('availableCrew', Number(event.target.value))}/></label></div><div className="planner-results"><Result label="Queue packages" value={packages.toLocaleString()}/><Result label="Projected pieces" value={pieces.toLocaleString()}/><Result label="Crew required" value={required.toFixed(1)}/><Result label="Crew gap" value={`${available - required >= 0 ? '+' : ''}${(available - required).toFixed(1)}`}/><Result label="Coverage" value={`${coverage}%`}/></div></section>
}

function Result({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div> }
function multiplier(ir: string) { const match = ir.match(/^(\d+)\s*:/); return match ? Number(match[1]) + 1 : 0 }
function sameMachine(left: string, right: string) { return canonical(left) === canonical(right) }
function canonical(value: string) { return value.trim().toUpperCase().replace(/^FERAG\s*/, 'F').replace(/^([A-Z]+)0+(\d+)$/, '$1$2') }
