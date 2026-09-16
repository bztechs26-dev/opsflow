import { useState } from 'react'
import type { ProductionRecord } from '../types/operations'

interface Props {
  records: ProductionRecord[]
  machines: string[]
  movingId: string | null
  onMove: (record: ProductionRecord, targetMachine: string) => void | Promise<void>
}

export function ProductionMoveControl({ records, machines, movingId, onMove }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const movable = records.filter((record) => !['COMPLETE', 'BLOCKED'].includes(record.status))
  const move = async (record: ProductionRecord, targetMachine: string) => {
    if (targetMachine === record.machine) return
    await onMove(record, targetMachine)
  }

  return <>
    <button className="primary-button" type="button" onClick={() => setIsOpen(true)}>Move ZIPs</button>
    {isOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="move-zips-title"><section className="upload-modal move-zips-modal"><div className="panel-header"><div><h2 id="move-zips-title">Move ZIPs between machines</h2><span>Select a different machine to move an unfinished ZIP immediately.</span></div><button className="secondary-button" type="button" onClick={() => setIsOpen(false)}>Close</button></div><div className="table-wrap"><table className="data-table"><thead><tr><th>ZIP / ATZ</th><th>Current machine</th><th>Quantity</th><th>Status</th><th>Move to machine</th></tr></thead><tbody>{movable.map((record) => <tr key={record.id}><td>{record.zip}</td><td>{record.machine}</td><td>{record.volume.toLocaleString()} pcs</td><td>{record.status.replaceAll('_', ' ')}</td><td><select className="status-select" value={record.machine} disabled={movingId === record.id || machines.length < 2} onChange={(event) => void move(record, event.target.value)}>{machines.map((machine) => <option key={machine} value={machine}>{machine}</option>)}</select></td></tr>)}</tbody></table></div>{!movable.length && <p className="empty-state">No unfinished ZIPs are available to move. Complete and Short ZIPs remain locked.</p>}</section></div>}
  </>
}
