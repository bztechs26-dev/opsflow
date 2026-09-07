import type { ProductionRecord } from '../types/operations'

export type MachineCapacity = { machine: string; rate: number; totalPieces: number; completePieces: number; runnablePieces: number; blockedPieces: number; skippedPieces: number; estimatedHours?: number; percentComplete: number }

export function machineRate(machine: string) {
  const normalized = machine.trim().toUpperCase()
  if (/^A\d+/.test(normalized) && normalized !== 'A05') return 10_000
  if (/^(?:FERAG|F)\s*0?\d+/.test(normalized)) return 20_000
  return 0
}

export function capacityForMachine(machine: string, records: ProductionRecord[]): MachineCapacity | undefined {
  const rate = machineRate(machine)
  if (!rate) return undefined
  const totalPieces = records.reduce((total, record) => total + record.volume, 0)
  const completePieces = records.filter((record) => record.status === 'COMPLETE').reduce((total, record) => total + record.volume, 0)
  const blockedPieces = records.filter((record) => record.status === 'BLOCKED').reduce((total, record) => total + record.volume, 0)
  const skippedPieces = records.filter((record) => record.status === 'SKIPPED').reduce((total, record) => total + record.volume, 0)
  const runnablePieces = records.filter((record) => !['COMPLETE', 'BLOCKED', 'SKIPPED'].includes(record.status)).reduce((total, record) => total + record.volume, 0)
  return { machine, rate, totalPieces, completePieces, runnablePieces, blockedPieces, skippedPieces, estimatedHours: runnablePieces ? runnablePieces / rate : undefined, percentComplete: totalPieces ? Math.round(completePieces / totalPieces * 100) : 0 }
}

export function formatRunHours(hours: number | undefined) {
  if (hours === undefined) return 'No runnable work'
  return `${hours.toFixed(hours < 10 ? 1 : 0)} run hr${Math.round(hours) === 1 ? '' : 's'}`
}
