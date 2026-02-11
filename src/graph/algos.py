"""Graph algorithms for"""

from __future__ import annotations

from collections import defaultdict

from utils import path_to_module


def build_dependency_graph(imports_data: dict[str, list[dict]]) -> dict[str, set[str]]:
    """Build a dependency graph from import data.

    Args:
        imports_data: Dictionary mapping file paths to their import data

    Returns:
        Dictionary representing the dependency graph where keys are module names
        and values are sets of modules they depend on
    """
    graph: dict[str, set[str]] = defaultdict(set)

    for file_path, imports in imports_data.items():
        module_name = path_to_module(file_path)
        for imp in imports:
            graph[module_name].add(imp["module"])

    return dict(graph)


class _TarjanState:
    """Mutable state container for Tarjan's SCC algorithm."""

    def __init__(self) -> None:
        self.index = 0
        self.indices: dict[str, int] = {}
        self.low_link: dict[str, int] = {}
        self.on_stack: set[str] = set()
        self.stack: list[str] = []
        self.sccs: list[list[str]] = []


def _extract_scc(state: _TarjanState, root: str) -> list[str]:
    """Extract a strongly connected component from the stack."""
    scc: list[str] = []
    while state.stack:
        w = state.stack.pop()
        state.on_stack.remove(w)
        scc.append(w)
        if w == root:
            break
    if root not in scc:
        msg = (
            f"Tarjan algorithm invariant violated: root node {root!r} "
            "not found in stack during SCC extraction."
        )
        raise RuntimeError(msg)
    return scc


def _strongconnect(node: str, graph: dict[str, set[str]], state: _TarjanState) -> None:
    """Process a node in Tarjan's algorithm."""
    state.indices[node] = state.index
    state.low_link[node] = state.index
    state.index += 1
    state.stack.append(node)
    state.on_stack.add(node)

    for neighbor in sorted(graph.get(node, set())):
        if neighbor not in state.indices:
            _strongconnect(neighbor, graph, state)
            state.low_link[node] = min(state.low_link[node], state.low_link[neighbor])
        elif neighbor in state.on_stack:
            state.low_link[node] = min(state.low_link[node], state.indices[neighbor])

    if state.low_link[node] == state.indices[node]:
        scc = _extract_scc(state, node)
        if len(scc) > 1 or node in graph.get(node, set()):
            state.sccs.append(scc)


def find_cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    """Find cycles in a directed graph using Tarjan's algorithm.

    Args:
        graph: Dictionary representing the graph

    Returns:
        List of cycles, where each cycle is a list of nodes
    """
    state = _TarjanState()

    for node in graph:
        if node not in state.indices:
            _strongconnect(node, graph, state)

    return state.sccs


__all__ = [
    "_TarjanState",
    "_extract_scc",
    "_strongconnect",
    "build_dependency_graph",
    "find_cycles",
]
