import { useMemo, useState } from 'react'
import type { ProductionRecord } from '../types/operations'

interface Props {
  records: ProductionRecord[]
  machines: string[]
  movingId: string | null
  onMove: (record: ProductionRecord, targetMachine: string) => void | Promise<void>
}

export function InlineZipMoveControl({ records, machines, movingId, onMove }: Props) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [targetMachine, setTargetMachine] = useState('')
  const active = useMemo(() => records.filter((record) => !['COMPLETE', 'BLOCKED'].includes(record.status)), [records])
  const normalized = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  const choices = active.filter((record) => !normalized || record.zip.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(normalized))
  const selected = active.find((record) => record.id === selectedId)
  const targets = machines.filter((machine) => machine !== selected?.machine)
  const submit = async () => {
    if (!selected || !targetMachine) return
    await onMove(selected, targetMachine)
    setSelectedId('')
    setTargetMachine('')
  }

  return <section className="panel inline-zip-move">
    <div><strong>Move an active ZIP</strong><span>Choose the ZIP and its receiving machine. Progress and projection update immediately.</span></div>
    <label>Find ZIP<input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedId('') }} placeholder="Search ZIP / ATZ" /></label>
    <label>ZIP<select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setTargetMachine('') }}><option value="">Select ZIP</option>{choices.map((record) => <option key={record.id} value={record.id}>{record.zip} · {record.machine} · {record.market}</option>)}</select></label>
    <label>Move to<select value={targetMachine} disabled={!selected} onChange={(event) => setTargetMachine(event.target.value)}><option value="">Select machine</option>{targets.map((machine) => <option key={machine} value={machine}>{machine}</option>)}</select></label>
    <button className="primary-button" type="button" disabled={!selected || !targetMachine || movingId === selected.id} onClick={() => void submit()}>{movingId === selected?.id ? 'Moving...' : 'Move ZIP'}</button>
    <small>{active.length} active ZIP{active.length === 1 ? '' : 's'} available to move. Complete and Short ZIPs are locked.</small>
  </section>
}
