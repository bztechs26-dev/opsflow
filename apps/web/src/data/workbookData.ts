import * as XLSX from 'xlsx'
import type { Load, ProductionRecord, ProductionStatus, QueuePlan } from '../types/operations'
interface CrewSizeRow { Machine?: unknown; 'Expected Packages'?: unknown; 'LHPT Goal'?: unknown }
interface BulkPlanRow { 'Shipment ID'?: unknown; 'Service Provider Name'?: unknown; 'First Equipment Group ID'?: unknown; 'Destination Location Name'?: unknown; 'Total Gross Weight'?: unknown; 'Number of Stops'?: unknown }
type BulkPlanCellRow = unknown[]
export interface OperationalData { productionRecords: ProductionRecord[]; loads: Load[]; queuePlan?: QueuePlan }
export function parseProductionWorkbook(production: ArrayBuffer, week: string) { return parseOperationalData(production, undefined, week).productionRecords }
export function parseRawProductionWorkbook(production: ArrayBuffer, week: string, area: string) { return parseProduction(production, week, area).productionRecords }
export function parseTripMappingWorkbook(workbook: ArrayBuffer) { const source = XLSX.read(workbook, { type: 'array' }); const links = new Map<string, string[]>(); for (const sheet of source.SheetNames) { for (const row of XLSX.utils.sheet_to_json<unknown[]>(source.Sheets[sheet], { header: 1, defval: '' })) { const zip = zipKey(row[0]); const trip = text(row[2]); if (!zip || !/^\d+$/.test(trip)) continue; links.set(zip, [...new Set([...(links.get(zip) ?? []), trip])]) } } if (!links.size) throw new Error('No ZIP and TR pairs were found. Expected ZIP in column A and TR in column C.'); return links }
export function isTripMappingWorkbook(workbook: ArrayBuffer) { const source = XLSX.read(workbook, { type: 'array' }); return source.SheetNames.some((sheet) => XLSX.utils.sheet_to_json<unknown[]>(source.Sheets[sheet], { header: 1, defval: '' }).slice(0, 10).some((row) => text(row[0]).toLowerCase() === 'zip' && text(row[2]).toLowerCase() === 'tr')) }
export function parseBulkPlanWorkbook(bulk: ArrayBuffer, week: string) { return parseOperationalData(undefined, bulk, week).loads }
export function parseOperationalData(production: ArrayBuffer | undefined, bulk: ArrayBuffer | undefined, week: string): OperationalData { const productionData = production ? parseProduction(production, week) : { productionRecords: [] }; const loads = bulk ? parseBulk(bulk, week) : []; return { ...productionData, loads } }
function parseProduction(production: ArrayBuffer, week: string, area?: string) { const p = XLSX.read(production, { type: 'array' }); const named = ['FE', 'BE', 'PROV-BOST', 'MMSI'].filter((name) => p.Sheets[name]); const sheets = named.length && !area ? named : p.SheetNames; const productionRecords = sheets.flatMap((sheet) => XLSX.utils.sheet_to_json<unknown[]>(p.Sheets[sheet], { header: 1, defval: '' }).filter((row) => isZip(text(row[0])) && Number(row[1]) > 0).map((row, index) => ({ id: `${week}-${area ?? sheet}-${index}`, week, market: text(row[4]) || area || sheet, jobNumber: text(row[3]) || undefined, machine: text(row[6]) || text(row[5]) || 'Unassigned', scheduledMachine: text(row[5]) || undefined, zip: formatZip(text(row[0])), status: normalize(text(row[7])), sourceStatus: text(row[7]) || 'Blank', volume: Number(row[1]) || 0, ir: text(row[2]), queueOrder: index }))); if (!productionRecords.length) throw new Error('No ZIP-level production rows were found. Check that column A contains ZIP/ATZ values and column B contains quantities.'); return { productionRecords, queuePlan: parseQueuePlan(p) } }
function parseQueuePlan(workbook: XLSX.WorkBook): QueuePlan | undefined { const sheet = workbook.Sheets['Crew Size']; if (!sheet) return undefined; const rows = XLSX.utils.sheet_to_json<CrewSizeRow>(sheet, { range: 1, defval: '' }); const machines = rows.map((row) => ({ machine: text(row.Machine), expectedPackages: Number(row['Expected Packages']), lhptGoal: Number(row['LHPT Goal']) })).filter((row) => row.machine && Number.isFinite(row.expectedPackages) && row.expectedPackages > 0 && Number.isFinite(row.lhptGoal) && row.lhptGoal > 0); const shiftHours = Number(sheet.B1?.v); return machines.length && Number.isFinite(shiftHours) && shiftHours > 0 ? { shiftHours, machines } : undefined }
function parseBulk(bulk: ArrayBuffer, week: string): Load[] {
  const workbook = XLSX.read(bulk, { type: 'array' })
  // The operational export keeps its canonical, schedule-rich rows in Data. The
  // report tabs are arranged for human review and can repeat the same shipment.
  const dataSheet = workbook.Sheets.Data
  const dataLoads = dataSheet ? parseBulkDataSheet(dataSheet, week) : []
  const groupedLoads = parseBulkAreaSheets(workbook, week, dataLoads)
  if (groupedLoads.length) return groupedLoads
  if (dataLoads.length) return dataLoads

  const bulkSheet = workbook.SheetNames.find((name) => hasColumns<BulkPlanRow>(workbook.Sheets[name], ['Shipment ID', 'Service Provider Name', 'Destination Location Name']))
  if (!bulkSheet) throw new Error('No matching Bulk Plan worksheet was found. Expected a Data sheet or a worksheet with Shipment ID, carrier, and destination columns.')
  const loads = XLSX.utils.sheet_to_json<BulkPlanRow>(workbook.Sheets[bulkSheet]).filter((row) => text(row['Shipment ID']) && text(row['Shipment ID']).toLowerCase() !== 'shipment id').map((row) => loadFromValues(week, {
    shipmentId: row['Shipment ID'], carrier: row['Service Provider Name'], equipment: row['First Equipment Group ID'], destination: row['Destination Location Name'], weight: row['Total Gross Weight'], stops: row['Number of Stops'],
  }))
  if (!loads.length) throw new Error('The Bulk Plan workbook contains no valid load rows.')
  return loads
}
function parseBulkAreaSheets(workbook: XLSX.WorkBook, week: string, detailLoads: Load[]): Load[] {
  const byShipment = new Map(detailLoads.map((load) => [load.number, load]))
  const grouped: Load[] = []
  for (const sheetName of workbook.SheetNames) {
    const area = shippingAreaForSheet(sheetName)
    if (!area) continue
    const rows = XLSX.utils.sheet_to_json<BulkPlanCellRow>(workbook.Sheets[sheetName], { header: 1, defval: '', blankrows: false })
    let headers: string[] = []
    let sectionLines: string[] = []
    let routeGroup = `${area} direct loads`
    let routeRole: Load['routeRole'] = 'DIRECT'
    let linehaulCount = 0
    let sawLinehaul = false
    for (const row of rows) {
      if (row.some((value) => text(value) === 'Shipment ID' || text(value) === 'Shipment Number')) { headers = row.map(text); continue }
      const shipmentColumn = columnIndex(headers, headers.includes('Shipment ID') ? 'Shipment ID' : 'Shipment Number', 0)
      const number = text(row[shipmentColumn])
      if (!headers.length) continue
      if (!number || !/^\d+$/.test(number)) {
        const heading = text(row[0])
        if (heading) {
          if (heading.toLowerCase() === 'shared') { routeGroup = 'Shared direct delivery'; routeRole = 'SHARED'; sectionLines = [heading]; sawLinehaul = false; linehaulCount = 0 }
          else { sectionLines = [...sectionLines, heading].slice(-2); const title = sectionLines.join(' — '); if (/hub\s*&?\s*spoke/i.test(title)) { routeGroup = title; routeRole = 'HUB_LINEHAUL'; sawLinehaul = false; linehaulCount = 0 } else if (!sawLinehaul) { routeGroup = title; routeRole = 'DIRECT' } }
        } else if (routeRole === 'HUB_LINEHAUL' && linehaulCount > 0) { routeRole = 'HUB_SPOKE'; sawLinehaul = true }
        continue
      }
      const detail = byShipment.get(number)
      const value = (column: string) => row[columnIndex(headers, column, 0)]
      const isHubDestination = /hub/i.test(text(value('Destination')) || text(value('Destination SCF')))
      if (routeRole === 'HUB_LINEHAUL' && !isHubDestination && linehaulCount > 0) { routeRole = 'HUB_SPOKE'; sawLinehaul = true }
      const load = detail ? { ...detail, area, routeGroup, routeRole } : { ...loadFromValues(week, { shipmentId: number, carrier: value('Carrier'), equipment: value('Equipment'), destination: value('Destination') || value('Destination SCF'), weight: value('Weight'), stops: value('# of Stops'), pickup: value('Pick release') || value('Pick Release') }), area, routeGroup, routeRole }
      grouped.push(load)
      if (routeRole === 'HUB_LINEHAUL') linehaulCount += 1
    }
  }
  const seen = new Set<string>()
  return grouped.filter((load) => !seen.has(load.id) && Boolean(seen.add(load.id)))
}
function shippingAreaForSheet(sheetName: string) { const name = sheetName.toLowerCase(); if (name.includes('front')) return 'FRONT_END'; if (name.includes('back')) return 'BACK_END'; if (name.includes('solo')) return 'SOLO'; if (name.includes('mmsi')) return 'MMSI'; if (name.includes('prov') || name.includes('boston')) return 'PROVIDENCE_BOSTON'; return undefined }
function parseBulkDataSheet(sheet: XLSX.WorkSheet, week: string): Load[] {
  const rows = XLSX.utils.sheet_to_json<BulkPlanCellRow>(sheet, { header: 1, defval: '', blankrows: false })
  let headers: string[] = []
  const seen = new Set<string>()
  const loads: Load[] = []
  for (const row of rows) {
    if (row.some((value) => text(value) === 'Shipment ID')) { headers = row.map(text); continue }
    const value = (column: string, occurrence = 0) => row[columnIndex(headers, column, occurrence)]
    const shipmentId = value('Shipment ID')
    if (!headers.length || !text(shipmentId) || text(shipmentId).toLowerCase() === 'shipment id' || seen.has(text(shipmentId))) continue
    seen.add(text(shipmentId))
    loads.push(loadFromValues(week, {
      shipmentId, carrier: value('Service Provider Name'), equipment: value('First Equipment Group ID'), destination: value('Destination Location Name'), weight: value('Total Gross Weight'), stops: value('Number of Stops'), pickup: value('Start Time'), delivery: value('End Time'), sourceStatus: `${text(value('Status'))} ${text(value('Status', 1))} ${text(value('8125_Status'))}`,
    }))
  }
  return loads
}
function columnIndex(headers: string[], column: string, occurrence: number) { let matches = 0; for (let index = 0; index < headers.length; index += 1) { if (headers[index] === column && matches++ === occurrence) return index } return -1 }
function loadFromValues(week: string, values: { shipmentId: unknown; carrier: unknown; equipment: unknown; destination: unknown; weight: unknown; stops: unknown; pickup?: unknown; delivery?: unknown; sourceStatus?: string }): Load {
  const pickup = text(values.pickup)
  const delivery = text(values.delivery)
  return { id: `${week}-load-${text(values.shipmentId)}`, number: text(values.shipmentId), carrier: text(values.carrier) || 'Unassigned carrier', destination: text(values.destination) || 'Unassigned destination', destinationType: destinationType(text(values.destination)), equipment: text(values.equipment).replaceAll('_', ' ') || 'Not specified', weight: `${Math.round(Number(values.weight) || 0).toLocaleString()} lb`, stops: Number(values.stops) || 0, pickup: pickup || 'Bulk-plan schedule pending', deliveryDate: delivery || undefined, status: loadStatus(values.sourceStatus) }
}
function destinationType(destination: string) { return /hub/i.test(destination) ? 'HUB' : /scf/i.test(destination) ? 'SCF' : 'DDU' }
function loadStatus(sourceStatus = ''): Load['status'] { const status = sourceStatus.toLowerCase(); if (/deliver/.test(status)) return 'DELIVERED'; if (/in[ _-]?transit/.test(status)) return 'IN_TRANSIT'; if (/loaded/.test(status)) return 'LOADED'; if (/delay/.test(status)) return 'DELAYED'; if (/issue|declin|cancel/.test(status)) return 'ISSUE'; if (/ready|accept/.test(status)) return 'READY'; if (/plan/.test(status)) return 'PLANNED'; return 'SCHEDULED' }
function hasColumns<T>(sheet: XLSX.WorkSheet | undefined, columns: string[]) { if (!sheet) return false; const rows = XLSX.utils.sheet_to_json<T>(sheet, { range: 0, defval: '' }); return rows.length > 0 && columns.every((column) => Object.hasOwn(rows[0] as object, column)) }
function text(value: unknown) { return String(value ?? '').trim() }
export function zipKey(value: unknown) { const normalized = text(value).replace(/\s+/g, '').toUpperCase(); return /^\d{5}(?:[A-Z](?:\d+)?)?$/.test(normalized) ? normalized : '' }
function isZip(value: string) { return /^\d{3,5}(?:\s+[A-Za-z](?:\d+)?)?$/.test(value) }
function formatZip(value: string) { const [zip, suffix] = value.split(/\s+/, 2); return `${zip.padStart(5, '0')}${suffix ? ` ${suffix}` : ''}` }
function normalize(status: string): ProductionStatus { switch (status.toLowerCase()) { case 'done': return 'COMPLETE'; case 'in process': return 'IN_PROGRESS'; case 'hold': case 'short': return 'BLOCKED'; default: return 'NOT_STARTED' } }
