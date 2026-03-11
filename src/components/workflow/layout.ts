/**
 * Auto-layout using dagre for top-to-bottom graph layout
 */
import dagre from 'dagre';
import type { FlowNode, FlowEdge } from './converters';

const NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  start: { width: 96, height: 40 },
  end: { width: 96, height: 40 },
  task: { width: 200, height: 60 },
  condition: { width: 120, height: 120 },
  parallel: { width: 180, height: 60 },
  wait: { width: 180, height: 60 },
};

const DEFAULT_DIM = { width: 200, height: 60 };

export function autoLayout(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 100 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => {
    const dim = NODE_DIMENSIONS[n.type ?? ''] ?? DEFAULT_DIM;
    g.setNode(n.id, { width: dim.width, height: dim.height });
  });

  edges.forEach((e) => {
    g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    if (!pos) return n;
    const dim = NODE_DIMENSIONS[n.type ?? ''] ?? DEFAULT_DIM;
    return {
      ...n,
      position: {
        x: pos.x - dim.width / 2,
        y: pos.y - dim.height / 2,
      },
    };
  });
}
