export type ProductionStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE' | 'BLOCKED' | 'SKIPPED'
export type LoadStatus = 'PLANNED' | 'SCHEDULED' | 'READY' | 'DELAYED' | 'LOADED' | 'IN_TRANSIT' | 'DELIVERED' | 'ISSUE'
export interface MachineTransfer { from: string; to: string; movedAt: string }
export interface ProductionRecord { id: string; week: string; market: string; jobNumber?: string; machine: string; scheduledMachine?: string; movedAt?: string; transferHistory?: MachineTransfer[]; tripNumbers?: string[]; zip: string; status: ProductionStatus; sourceStatus: string; volume: number; ir: string; queueOrder: number; notes?: string }
export interface QueueMachinePlan { machine: string; expectedPackages: number; lhptGoal: number; availableCrew?: number }
export interface QueuePlan { shiftHours: number; machines: QueueMachinePlan[] }
export type LoadRouteRole = 'DIRECT' | 'HUB_LINEHAUL' | 'HUB_SPOKE' | 'SHARED'
export interface Load { id: string; number: string; area?: string; routeGroup?: string; routeRole?: LoadRouteRole; carrier: string; destination: string; destinationType?: string; equipment: string; weight: string; stops: number; pickup: string; deliveryDate?: string; deliveryTime?: string; status: LoadStatus; notes?: string; issues?: string }
export interface OperationalWeek { id: string; label: string; productionRecords: ProductionRecord[]; loads: Load[]; queuePlan?: QueuePlan; tripMappings?: Record<string, string[]>; source: 'uploaded'; uploadedAt: string; productionFileName: string; bulkPlanFileName: string; fileHashes: string[]; productionParserVersion?: number; bulkPlanParserVersion?: number }
export interface NavigationItem { id: string; label: string; icon: 'grid' | 'factory' | 'truck' | 'box' | 'chart' }
