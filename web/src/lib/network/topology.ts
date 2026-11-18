/*
 * A readable left-to-right tree for `GET /network/topology`: the probe at the root, the LLDP-linked
 * infrastructure (switches, routers, access points) as a subtree under it, and everything only seen by
 * ARP hanging off the probe. Parents sit centred on their children.
 */
import type { NetworkTopology, TopologyNode } from '@/lib/api/types'

export interface PlacedNode {
  node: TopologyNode
  depth: number
  x: number
  y: number
  children: number
}

export interface PlacedLink {
  from: PlacedNode
  to: PlacedNode
  kind: 'lldp' | 'arp'
  localPort: string | null
}

export interface TopologyLayout {
  nodes: PlacedNode[]
  links: PlacedLink[]
  width: number
  height: number
}

const INFRA = new Set(['switch', 'router', 'ap'])

export function layoutTopology(topology: NetworkTopology, options: { column?: number; row?: number; nodeWidth?: number } = {}): TopologyLayout {
  const column = options.column ?? 230
  const row = options.row ?? 40
  const nodeWidth = options.nodeWidth ?? 180
  const byId = new Map(topology.nodes.map((node) => [node.id, node]))
  const lldp = new Map<string, Map<string, string | null>>()
  for (const edge of topology.edges) {
    if (edge.kind !== 'lldp' || !byId.has(edge.from) || !byId.has(edge.to)) continue
    if (!lldp.has(edge.from)) lldp.set(edge.from, new Map())
    if (!lldp.has(edge.to)) lldp.set(edge.to, new Map())
    lldp.get(edge.from)!.set(edge.to, edge.local_port ?? null)
    lldp.get(edge.to)!.set(edge.from, null)
  }

  const root = topology.nodes.find((node) => node.kind === 'probe') ?? null
  const parent = new Map<string, string | null>()
  if (root) parent.set(root.id, null)

  // The busiest LLDP node is the core; walk the LLDP graph from it.
  const infra = (id: string) => (INFRA.has(byId.get(id)?.type ?? '') ? (byId.get(id)?.type === 'ap' ? 1 : 2) : 0)
  const candidates = [...lldp.keys()]
    .filter((id) => id !== root?.id)
    .sort((a, b) => (lldp.get(b)?.size ?? 0) - (lldp.get(a)?.size ?? 0) || infra(b) - infra(a) || a.localeCompare(b))
  const visit = (start: string) => {
    if (parent.has(start)) return
    parent.set(start, root?.id ?? null)
    const queue = [start]
    while (queue.length) {
      const current = queue.shift()!
      for (const next of [...(lldp.get(current)?.keys() ?? [])].sort()) {
        if (parent.has(next)) continue
        parent.set(next, current)
        queue.push(next)
      }
    }
  }
  for (const id of candidates) visit(id)
  for (const node of topology.nodes) if (!parent.has(node.id)) parent.set(node.id, root?.id ?? null)

  const children = new Map<string | null, TopologyNode[]>()
  for (const node of topology.nodes) {
    const key = parent.get(node.id) ?? null
    if (node.id === root?.id) continue
    children.set(key, [...(children.get(key) ?? []), node])
  }
  const weight = (node: TopologyNode) => (children.get(node.id)?.length ? 0 : INFRA.has(node.type ?? '') ? 1 : node.kind === 'snmp' ? 2 : 3)
  for (const list of children.values()) list.sort((a, b) => weight(a) - weight(b) || (a.type ?? '').localeCompare(b.type ?? '') || a.label.localeCompare(b.label))

  const placed = new Map<string, PlacedNode>()
  let nextRow = 0
  const place = (node: TopologyNode, depth: number): PlacedNode => {
    const kids = children.get(node.id) ?? []
    const items = kids.map((child) => place(child, depth + 1))
    const y = items.length ? (items[0].y + items[items.length - 1].y) / 2 : nextRow++ * row
    const entry: PlacedNode = { node, depth, x: depth * column, y, children: kids.length }
    placed.set(node.id, entry)
    return entry
  }
  if (root) place(root, 0)
  else for (const node of children.get(null) ?? []) place(node, 0)

  const links: PlacedLink[] = []
  for (const [id, parentId] of parent) {
    if (!parentId) continue
    const from = placed.get(parentId)
    const to = placed.get(id)
    if (!from || !to) continue
    const viaLldp = lldp.get(parentId)?.has(id) ?? false
    links.push({ from, to, kind: viaLldp ? 'lldp' : 'arp', localPort: viaLldp ? (lldp.get(parentId)?.get(id) ?? null) : null })
  }
  const nodes = [...placed.values()]
  const maxDepth = Math.max(0, ...nodes.map((node) => node.depth))
  return { nodes, links, width: maxDepth * column + nodeWidth, height: Math.max(row, nextRow * row) }
}
