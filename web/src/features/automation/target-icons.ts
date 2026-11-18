import { Boxes, Building, Globe, MapPin, MonitorSmartphone } from 'lucide-react'
import type { PolicyTargetType } from '@/lib/api/types'

/** Icons for policy assignment targets. */
export const TARGET_ICON: Record<PolicyTargetType, typeof Globe> = {
  global: Globe,
  client: Building,
  site: MapPin,
  group: Boxes,
  device: MonitorSmartphone,
}
