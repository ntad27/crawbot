/**
 * Unit tests for workflow DAG validation
 * Source: src/components/workflow/validation.ts
 */
import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '@/components/workflow/validation';
import type { FlowNode, FlowEdge } from '@/components/workflow/converters';

// ---- helpers ----

function makeNode(id: string, type = 'task', label = id): FlowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label },
  };
}

function makeEdge(source: string, target: string): FlowEdge {
  return { id: `${source}->${target}`, source, target };
}

const START = makeNode('__start__', 'start', 'Start');
const END = makeNode('__end__', 'end', 'End');

// ---- tests ----

describe('validateWorkflow — valid DAG', () => {
  it('passes for a minimal valid DAG: start → step1 → end', () => {
    const nodes = [START, makeNode('step1'), END];
    const edges = [makeEdge('__start__', 'step1'), makeEdge('step1', '__end__')];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes for a two-step linear DAG', () => {
    const nodes = [START, makeNode('step1'), makeNode('step2'), END];
    const edges = [
      makeEdge('__start__', 'step1'),
      makeEdge('step1', 'step2'),
      makeEdge('step2', '__end__'),
    ];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(true);
  });
});

describe('validateWorkflow — missing structural nodes', () => {
  it('fails when start node is missing', () => {
    const nodes = [makeNode('step1'), END];
    const edges = [makeEdge('step1', '__end__')];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing start node');
  });

  it('fails when end node is missing', () => {
    const nodes = [START, makeNode('step1')];
    const edges = [makeEdge('__start__', 'step1')];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing end node');
  });

  it('fails when both start and end are missing', () => {
    const nodes = [makeNode('step1')];
    const result = validateWorkflow(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing start node');
    expect(result.errors).toContain('Missing end node');
  });

  it('fails when there are no step nodes (only start + end)', () => {
    const nodes = [START, END];
    const edges = [makeEdge('__start__', '__end__')];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow has no steps');
  });
});

describe('validateWorkflow — cycle detection', () => {
  it('detects a direct cycle between two steps', () => {
    const nodes = [START, makeNode('step1'), makeNode('step2'), END];
    const edges = [
      makeEdge('__start__', 'step1'),
      makeEdge('step1', 'step2'),
      makeEdge('step2', 'step1'), // cycle
      makeEdge('step2', '__end__'),
    ];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow contains a cycle');
  });

  it('detects a self-loop', () => {
    const nodes = [START, makeNode('step1'), END];
    const edges = [
      makeEdge('__start__', 'step1'),
      makeEdge('step1', 'step1'), // self-loop
      makeEdge('step1', '__end__'),
    ];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Workflow contains a cycle');
  });
});

describe('validateWorkflow — orphan nodes', () => {
  it('detects a step with no connections at all', () => {
    const nodes = [START, makeNode('step1'), makeNode('orphan'), END];
    const edges = [makeEdge('__start__', 'step1'), makeEdge('step1', '__end__')];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('not connected'))).toBe(true);
  });

  it('uses node label in orphan error message', () => {
    const orphan = makeNode('step-x', 'task', 'My Orphan Step');
    const nodes = [START, makeNode('step1'), orphan, END];
    const edges = [makeEdge('__start__', 'step1'), makeEdge('step1', '__end__')];
    const result = validateWorkflow(nodes, edges);
    expect(result.errors.some((e) => e.includes('My Orphan Step'))).toBe(true);
  });
});

describe('validateWorkflow — condition node validation', () => {
  it('fails when condition node has only 1 output', () => {
    const cond = makeNode('cond1', 'condition', 'My Condition');
    const nodes = [START, cond, makeNode('stepA'), END];
    const edges = [
      makeEdge('__start__', 'cond1'),
      makeEdge('cond1', 'stepA'), // only 1 output
      makeEdge('stepA', '__end__'),
    ];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exactly 2 output connections'))).toBe(true);
  });

  it('fails when condition node has 0 outputs', () => {
    const cond = makeNode('cond1', 'condition', 'Empty Condition');
    const nodes = [START, cond, END];
    const edges = [makeEdge('__start__', 'cond1')];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exactly 2 output connections'))).toBe(true);
  });

  it('passes when condition node has exactly 2 outputs', () => {
    const cond = makeNode('cond1', 'condition', 'Branch');
    const nodes = [START, cond, makeNode('stepA'), makeNode('stepB'), END];
    const edges = [
      makeEdge('__start__', 'cond1'),
      makeEdge('cond1', 'stepA'),
      makeEdge('cond1', 'stepB'),
      makeEdge('stepA', '__end__'),
      makeEdge('stepB', '__end__'),
    ];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(true);
  });

  it('fails when condition node has 3 outputs', () => {
    const cond = makeNode('cond1', 'condition');
    const nodes = [START, cond, makeNode('a'), makeNode('b'), makeNode('c'), END];
    const edges = [
      makeEdge('__start__', 'cond1'),
      makeEdge('cond1', 'a'),
      makeEdge('cond1', 'b'),
      makeEdge('cond1', 'c'),
      makeEdge('a', '__end__'),
      makeEdge('b', '__end__'),
      makeEdge('c', '__end__'),
    ];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exactly 2 output connections'))).toBe(true);
  });
});

describe('validateWorkflow — reachability', () => {
  it('flags a step not reachable from start', () => {
    // step2 is only reachable from step1, but step1 is not connected from start
    const nodes = [START, makeNode('step1'), makeNode('step2'), END];
    const edges = [
      makeEdge('step1', 'step2'), // step1 has no incoming from start
      makeEdge('step2', '__end__'),
      makeEdge('__start__', '__end__'), // start goes directly to end, step1/2 unreachable
    ];
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(false);
  });
});
