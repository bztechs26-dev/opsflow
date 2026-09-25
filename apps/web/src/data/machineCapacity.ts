import type { ProductionRecord } from '../types/operations'

export type MachineCapacity = { machine: string; rate: number; totalPieces: number; completePieces: number; runnablePieces: number; blockedPieces: number; skippedPieces: number; estimatedHours?: number; percentComplete: number }
export type MachineMarketQueue = { market: string; pieces: number; firstQueueOrder: number }

// Workbooks are produced by more than one system.  Use one stable key for a
// machine rate so harmless differences in casing or spaces cannot make a
// saved rate appear to reset on the next shared-data refresh.
export function machineRateKey(machine: string) {
  try {
    return decodeURIComponent(machine).trim().replace(/\s+/g, ' ').toUpperCase()
  } catch {
    return machine.trim().replace(/\s+/g, ' ').toUpperCase()
  }
}

export function configuredMachineRate(rates: Record<string, number> | undefined, machine: string) {
  if (!rates) return undefined
  const key = machineRateKey(machine)
  return rates[machine] ?? rates[key] ?? Object.entries(rates).find(([storedMachine]) => machineRateKey(storedMachine) === key)?.[1]
}

export function machineRate(machine: string, activeRate?: number) {
  if (activeRate && allowedMachineRates(machine).includes(activeRate)) return activeRate
  const normalized = machine.trim().toUpperCase()
  if (/^A\d+/.test(normalized) && normalized !== 'A05') return 10_000
  if (normalized.startsWith('F')) return 20_000
  return 0
}

export function allowedMachineRates(machine: string) {
  const normalized = machine.trim().toUpperCase()
  if (/^A\d+/.test(normalized) && normalized !== 'A05') return [10_000, 8_000, 6_000]
  if (normalized.startsWith('F')) return [20_000, 18_000, 16_000]
  return []
}

export function formatMachineRate(rate: number) {
  return `${Math.round(rate / 1000)}K`
}

export function capacityForMachine(machine: string, records: ProductionRecord[], activeRate?: number): MachineCapacity | undefined {
  const rate = machineRate(machine, activeRate)
  if (!rate) return undefined
  const totalPieces = records.reduce((total, record) => total + record.volume, 0)
  // SHORT is represented by BLOCKED in stored data. Its available copies were
  // still produced, so it counts as processed while staying a visible exception.
  const completePieces = records.filter((record) => record.status === 'COMPLETE' || record.status === 'BLOCKED').reduce((total, record) => total + record.volume, 0)
  const blockedPieces = records.filter((record) => record.status === 'BLOCKED').reduce((total, record) => total + record.volume, 0)
  const skippedPieces = records.filter((record) => record.status === 'SKIPPED').reduce((total, record) => total + record.volume, 0)
  const runnablePieces = records.filter((record) => !['COMPLETE', 'BLOCKED', 'SKIPPED'].includes(record.status)).reduce((total, record) => total + record.volume, 0)
  return { machine, rate, totalPieces, completePieces, runnablePieces, blockedPieces, skippedPieces, estimatedHours: runnablePieces ? runnablePieces / rate : undefined, percentComplete: totalPieces ? Math.round(completePieces / totalPieces * 100) : 0 }
}

export function machineMarketQueue(records: ProductionRecord[]): MachineMarketQueue[] {
  const grouped = new Map<string, MachineMarketQueue>()
  for (const record of records) {
    if (['COMPLETE', 'BLOCKED', 'SKIPPED'].includes(record.status)) continue
    const market = record.market || 'Unassigned market'
    const current = grouped.get(market)
    grouped.set(market, current
      ? { ...current, pieces: current.pieces + record.volume, firstQueueOrder: Math.min(current.firstQueueOrder, record.queueOrder) }
      : { market, pieces: record.volume, firstQueueOrder: record.queueOrder })
  }
  return [...grouped.values()].sort((left, right) => left.firstQueueOrder - right.firstQueueOrder || right.pieces - left.pieces)
}

export function formatRunHours(hours: number | undefined) {
  if (hours === undefined) return 'No runnable work'
  return `${hours.toFixed(hours < 10 ? 1 : 0)} run hr${Math.round(hours) === 1 ? '' : 's'}`
}
