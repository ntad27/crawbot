/**
 * Workflow graph validation
 */
import type { FlowNode, FlowEdge } from './converters';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateWorkflow(nodes: FlowNode[], edges: FlowEdge[]): ValidationResult {
  const errors: string[] = [];

  const hasStart = nodes.some((n) => n.id === '__start__');
  const hasEnd = nodes.some((n) => n.id === '__end__');

  if (!hasStart) errors.push('Missing start node');
  if (!hasEnd) errors.push('Missing end node');

  const stepNodes = nodes.filter((n) => n.id !== '__start__' && n.id !== '__end__');
  if (stepNodes.length === 0) {
    errors.push('Workflow has no steps');
    return { valid: errors.length === 0, errors };
  }

  // Build adjacency
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  nodes.forEach((n) => {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  });
  edges.forEach((e) => {
    outgoing.get(e.source)?.push(e.target);
    incoming.get(e.target)?.push(e.source);
  });

  // Orphan check: step nodes with no edges
  stepNodes.forEach((n) => {
    const hasIn = (incoming.get(n.id)?.length ?? 0) > 0;
    const hasOut = (outgoing.get(n.id)?.length ?? 0) > 0;
    if (!hasIn && !hasOut) {
      errors.push(`Step "${n.data.label || n.id}" is not connected`);
    }
  });

  // Condition nodes must have exactly 2 outputs
  stepNodes
    .filter((n) => n.type === 'condition')
    .forEach((n) => {
      const outs = outgoing.get(n.id)?.length ?? 0;
      if (outs !== 2) {
        errors.push(
          `Condition "${n.data.label || n.id}" must have exactly 2 output connections (has ${outs})`,
        );
      }
    });

  // Cycle detection via DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();
  let hasCycle = false;

  function dfs(nodeId: string) {
    if (inStack.has(nodeId)) {
      hasCycle = true;
      return;
    }
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) {
      dfs(next);
    }
    inStack.delete(nodeId);
  }

  nodes.forEach((n) => {
    if (!visited.has(n.id)) dfs(n.id);
  });

  if (hasCycle) errors.push('Workflow contains a cycle');

  // All paths from start must reach end (BFS reachability)
  if (hasStart && hasEnd && !hasCycle) {
    const reachableFromStart = new Set<string>();
    const queue = ['__start__'];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (reachableFromStart.has(cur)) continue;
      reachableFromStart.add(cur);
      for (const next of outgoing.get(cur) ?? []) {
        queue.push(next);
      }
    }
    stepNodes.forEach((n) => {
      if (!reachableFromStart.has(n.id)) {
        errors.push(`Step "${n.data.label || n.id}" is not reachable from start`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
