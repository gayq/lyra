use std::collections::{BTreeSet, HashMap, VecDeque};

use crate::ast_table::{Cardinality, Field};
use crate::helper_index::HelperInfo;
use crate::reachability::AstGraph;
use crate::templates;

#[derive(Clone, Debug)]
pub enum Step {
	Field {
		node: &'static str,
		field: &'static str,
		child_ty: &'static str,
		card: Cardinality,
	},
	Variant {
		node: &'static str,
		variant: &'static str,
	},
	Leaf,
}

impl Step {
	fn target_ty(&self) -> &'static str {
		match self {
			Step::Field { child_ty, .. } => child_ty,
			Step::Variant { variant, .. } => variant,
			Step::Leaf => "IdentifierReference",
		}
	}
}

pub fn build_uncovered_hints(
	helpers: &HashMap<String, HelperInfo>,
	graph: &AstGraph,
) -> HashMap<&'static str, BTreeSet<String>> {
	let mut hints: HashMap<&'static str, BTreeSet<String>> = HashMap::new();
	for h in helpers.values() {
		if h.fully_covers {
			continue;
		}
		let Some(def) = graph.nodes.get(h.node_type.as_str()) else {
			continue;
		};
		if h.covered_all {
			continue;
		}

		let mut uncov_top: BTreeSet<String> = BTreeSet::new();
		for f in def.fields {
			if !graph.field_in_r(f) {
				continue;
			}
			if !h.covered_set.contains(f.name) {
				uncov_top.insert(f.name.to_string());
			}
		}
		for v in def.variants {
			if !graph.in_r(v) {
				continue;
			}
			if !h.covered_set.contains(*v) {
				uncov_top.insert(v.to_string());
			}
		}
		if !uncov_top.is_empty() {
			let entry = hints.entry(def.name).or_default();
			for u in uncov_top {
				entry.insert(u);
			}
		}

		for f in def.fields {
			if !graph.field_in_r(f) {
				continue;
			}
			let Some(field_def) = graph.nodes.get(f.ty) else {
				continue;
			};
			if field_def.variants.is_empty() {
				continue;
			}
			let mut uncov_v = BTreeSet::new();
			for v in field_def.variants {
				if !graph.in_r(v) {
					continue;
				}
				if !h.covered_set.contains(*v) {
					uncov_v.insert(v.to_string());
				}
			}
			if !uncov_v.is_empty() {
				let entry = hints.entry(field_def.name).or_default();
				for u in uncov_v {
					entry.insert(u);
				}
			}
		}
	}
	hints
}

pub fn find_witness(
	graph: &AstGraph,
	start_node: &'static str,
	start_field: &Field,
) -> Option<Vec<Step>> {
	find_witness_with_hints(graph, start_node, start_field, &HashMap::new())
}

pub fn find_witness_with_hints(
	graph: &AstGraph,
	start_node: &'static str,
	start_field: &Field,
	hints: &HashMap<&'static str, BTreeSet<String>>,
) -> Option<Vec<Step>> {
	if !hints.is_empty()
		&& let Some(path) = pivot_witness(graph, hints, start_node, start_field)
	{
		return Some(path);
	}
	let first = Step::Field {
		node: start_node,
		field: start_field.name,
		child_ty: start_field.ty,
		card: start_field.card,
	};

	if start_field.ty == "IdentifierReference" {
		return Some(vec![first, Step::Leaf]);
	}

	let mut parent: HashMap<&'static str, (&'static str, Step)> = HashMap::new();
	let mut queue: VecDeque<&'static str> = VecDeque::new();
	queue.push_back(start_field.ty);
	parent.insert(start_field.ty, ("__root__", first.clone()));

	while let Some(cur) = queue.pop_front() {
		if cur == "IdentifierReference" {
			let mut path = Vec::new();
			let mut t = cur;
			while t != "__root__" {
				let (p, step) = parent[t].clone();
				path.push(step);
				t = p;
			}
			path.reverse();
			path.push(Step::Leaf);
			return Some(path);
		}

		let Some(def) = graph.nodes.get(cur) else {
			continue;
		};

		let cur_hints = hints.get(cur);
		let is_uncovered = |name: &str| cur_hints.is_some_and(|s| s.contains(name));

		let mut preferred_variants: Vec<&&str> = Vec::new();
		let mut other_variants: Vec<&&str> = Vec::new();
		for v in def.variants {
			if !graph.in_r(v) {
				continue;
			}
			if is_uncovered(v) {
				preferred_variants.push(v);
			} else {
				other_variants.push(v);
			}
		}
		let mut preferred_fields: Vec<&Field> = Vec::new();
		let mut other_fields: Vec<&Field> = Vec::new();
		for f in def.fields {
			if !graph.in_r(f.ty) {
				continue;
			}
			if is_uncovered(f.name) {
				preferred_fields.push(f);
			} else {
				other_fields.push(f);
			}
		}

		for v in preferred_variants.iter().chain(other_variants.iter()) {
			if parent.contains_key(**v) {
				continue;
			}
			parent.insert(
				*v,
				(
					cur,
					Step::Variant {
						node: cur,
						variant: v,
					},
				),
			);
			queue.push_back(*v);
		}
		for f in preferred_fields.iter().chain(other_fields.iter()) {
			if parent.contains_key(f.ty) {
				continue;
			}
			parent.insert(
				f.ty,
				(
					cur,
					Step::Field {
						node: cur,
						field: f.name,
						child_ty: f.ty,
						card: f.card,
					},
				),
			);
			queue.push_back(f.ty);
		}
	}

	None
}

fn pivot_witness(
	graph: &AstGraph,
	hints: &HashMap<&'static str, BTreeSet<String>>,
	start_node: &'static str,
	start_field: &Field,
) -> Option<Vec<Step>> {
	let first = Step::Field {
		node: start_node,
		field: start_field.name,
		child_ty: start_field.ty,
		card: start_field.card,
	};
	let start_ty = start_field.ty;

	let pivot_chain = bfs_to_hint(graph, hints, start_ty)?;

	let mut path: Vec<Step> = Vec::new();
	path.push(first);
	path.extend(pivot_chain.steps);
	let mut cur_ty = pivot_chain.end_ty;

	loop {
		let cur_def = graph.nodes.get(cur_ty)?;
		let cur_hints = hints.get(cur_ty)?;

		let variant_hint = cur_def
			.variants
			.iter()
			.find(|v| cur_hints.contains(**v) && graph.in_r(v));
		if let Some(v) = variant_hint {
			path.push(Step::Variant {
				node: cur_ty,
				variant: v,
			});
			let inner = bfs_to_ident_with_hints(graph, v, hints)?;
			path.extend(inner);
			path.push(Step::Leaf);
			return Some(path);
		}

		let field_hint = cur_def
			.fields
			.iter()
			.find(|f| cur_hints.contains(f.name) && graph.in_r(f.ty));
		if let Some(f) = field_hint {
			path.push(Step::Field {
				node: cur_ty,
				field: f.name,
				child_ty: f.ty,
				card: f.card,
			});
			cur_ty = f.ty;
			continue;
		}

		return None;
	}
}

struct BfsChain {
	steps: Vec<Step>,
	end_ty: &'static str,
}

fn bfs_to_hint(
	graph: &AstGraph,
	hints: &HashMap<&'static str, BTreeSet<String>>,
	start_ty: &'static str,
) -> Option<BfsChain> {
	if hints.contains_key(start_ty) {
		return Some(BfsChain {
			steps: Vec::new(),
			end_ty: start_ty,
		});
	}
	let mut parent: HashMap<&'static str, (&'static str, Step)> = HashMap::new();
	let mut queue: VecDeque<&'static str> = VecDeque::new();
	queue.push_back(start_ty);

	while let Some(cur) = queue.pop_front() {
		if cur != start_ty && hints.contains_key(cur) {
			let mut steps = Vec::new();
			let mut t = cur;
			while t != start_ty {
				let (p, step) = parent[t].clone();
				steps.push(step);
				t = p;
			}
			steps.reverse();
			return Some(BfsChain { steps, end_ty: cur });
		}
		let Some(def) = graph.nodes.get(cur) else {
			continue;
		};
		for v in def.variants {
			if !graph.in_r(v) {
				continue;
			}
			if parent.contains_key(*v) {
				continue;
			}
			parent.insert(
				v,
				(
					cur,
					Step::Variant {
						node: cur,
						variant: v,
					},
				),
			);
			queue.push_back(v);
		}
		for f in def.fields {
			if !graph.in_r(f.ty) {
				continue;
			}
			if parent.contains_key(f.ty) {
				continue;
			}
			parent.insert(
				f.ty,
				(
					cur,
					Step::Field {
						node: cur,
						field: f.name,
						child_ty: f.ty,
						card: f.card,
					},
				),
			);
			queue.push_back(f.ty);
		}
	}
	None
}

fn bfs_to_ident_with_hints(
	graph: &AstGraph,
	start_ty: &'static str,
	hints: &HashMap<&'static str, BTreeSet<String>>,
) -> Option<Vec<Step>> {
	if start_ty == "IdentifierReference" {
		return Some(Vec::new());
	}
	let mut parent: HashMap<&'static str, (&'static str, Step)> = HashMap::new();
	let mut queue: VecDeque<&'static str> = VecDeque::new();
	queue.push_back(start_ty);
	parent.insert(start_ty, ("__root__", Step::Leaf));

	while let Some(cur) = queue.pop_front() {
		if cur == "IdentifierReference" {
			let mut out = Vec::new();
			let mut t = cur;
			while t != start_ty {
				let (p, step) = parent[t].clone();
				out.push(step);
				t = p;
			}
			out.reverse();
			return Some(out);
		}
		let Some(def) = graph.nodes.get(cur) else {
			continue;
		};
		let cur_hints = hints.get(cur);
		let is_pref = |name: &str| cur_hints.is_some_and(|s| s.contains(name));
		let mut variants_pref: Vec<&&str> = Vec::new();
		let mut variants_other: Vec<&&str> = Vec::new();
		for v in def.variants {
			if !graph.in_r(v) {
				continue;
			}
			if is_pref(v) {
				variants_pref.push(v);
			} else {
				variants_other.push(v);
			}
		}
		let mut fields_pref: Vec<&crate::ast_table::Field> = Vec::new();
		let mut fields_other: Vec<&crate::ast_table::Field> = Vec::new();
		for f in def.fields {
			if !graph.in_r(f.ty) {
				continue;
			}
			if is_pref(f.name) {
				fields_pref.push(f);
			} else {
				fields_other.push(f);
			}
		}
		for v in variants_pref.iter().chain(variants_other.iter()) {
			if parent.contains_key(**v) {
				continue;
			}
			parent.insert(
				*v,
				(
					cur,
					Step::Variant {
						node: cur,
						variant: v,
					},
				),
			);
			queue.push_back(*v);
		}
		for f in fields_pref.iter().chain(fields_other.iter()) {
			if parent.contains_key(f.ty) {
				continue;
			}
			parent.insert(
				f.ty,
				(
					cur,
					Step::Field {
						node: cur,
						field: f.name,
						child_ty: f.ty,
						card: f.card,
					},
				),
			);
			queue.push_back(f.ty);
		}
	}
	None
}

fn bfs_to_ident(graph: &AstGraph, start_ty: &'static str) -> Option<Vec<Step>> {
	if start_ty == "IdentifierReference" {
		return Some(Vec::new());
	}
	let mut parent: HashMap<&'static str, (&'static str, Step)> = HashMap::new();
	let mut queue: VecDeque<&'static str> = VecDeque::new();
	queue.push_back(start_ty);
	parent.insert(start_ty, ("__root__", Step::Leaf));

	while let Some(cur) = queue.pop_front() {
		if cur == "IdentifierReference" {
			let mut out = Vec::new();
			let mut t = cur;
			while t != start_ty {
				let (p, step) = parent[t].clone();
				out.push(step);
				t = p;
			}
			out.reverse();
			return Some(out);
		}
		let Some(def) = graph.nodes.get(cur) else {
			continue;
		};
		for v in def.variants {
			if !graph.in_r(v) {
				continue;
			}
			if parent.contains_key(*v) {
				continue;
			}
			parent.insert(
				v,
				(
					cur,
					Step::Variant {
						node: cur,
						variant: v,
					},
				),
			);
			queue.push_back(v);
		}
		for f in def.fields {
			if !graph.in_r(f.ty) {
				continue;
			}
			if parent.contains_key(f.ty) {
				continue;
			}
			parent.insert(
				f.ty,
				(
					cur,
					Step::Field {
						node: cur,
						field: f.name,
						child_ty: f.ty,
						card: f.card,
					},
				),
			);
			queue.push_back(f.ty);
		}
	}
	None
}

fn dfs_witness_through_hints(
	graph: &AstGraph,
	hints: &HashMap<&'static str, BTreeSet<String>>,
	cur: &'static str,
	path: &mut Vec<Step>,
	visits: &mut HashMap<&'static str, usize>,
	depth: usize,
	max_depth: usize,
) -> bool {
	if cur == "IdentifierReference" {
		return true;
	}
	if depth >= max_depth {
		return false;
	}
	let count = visits.entry(cur).or_insert(0);
	if *count >= 3 {
		return false;
	}
	*count += 1;

	let Some(def) = graph.nodes.get(cur) else {
		*visits.get_mut(cur).unwrap() -= 1;
		return false;
	};

	let cur_hints = hints.get(cur);
	let is_pref = |name: &str| cur_hints.is_some_and(|s| s.contains(name));

	let mut variants_pref: Vec<&&str> = Vec::new();
	let mut variants_other: Vec<&&str> = Vec::new();
	for v in def.variants {
		if !graph.in_r(v) {
			continue;
		}
		if is_pref(v) {
			variants_pref.push(v);
		} else {
			variants_other.push(v);
		}
	}
	let mut fields_pref: Vec<&Field> = Vec::new();
	let mut fields_other: Vec<&Field> = Vec::new();
	for f in def.fields {
		if !graph.in_r(f.ty) {
			continue;
		}
		if is_pref(f.name) {
			fields_pref.push(f);
		} else {
			fields_other.push(f);
		}
	}

	for v in variants_pref.iter().chain(variants_other.iter()) {
		path.push(Step::Variant {
			node: cur,
			variant: v,
		});
		if dfs_witness_through_hints(graph, hints, v, path, visits, depth + 1, max_depth) {
			*visits.get_mut(cur).unwrap() -= 1;
			return true;
		}
		path.pop();
	}
	for f in fields_pref.iter().chain(fields_other.iter()) {
		path.push(Step::Field {
			node: cur,
			field: f.name,
			child_ty: f.ty,
			card: f.card,
		});
		if dfs_witness_through_hints(graph, hints, f.ty, path, visits, depth + 1, max_depth) {
			*visits.get_mut(cur).unwrap() -= 1;
			return true;
		}
		path.pop();
	}

	*visits.get_mut(cur).unwrap() -= 1;
	false
}

pub fn render_snippet(graph: &AstGraph, path: &[Step]) -> String {
	render_at(graph, path, 0)
}

fn render_at(graph: &AstGraph, path: &[Step], idx: usize) -> String {
	match &path[idx] {
		Step::Leaf => templates::template("IdentifierReference").to_string(),
		Step::Field { node, field, .. } => {
			let inner = render_at(graph, path, idx + 1);
			fill_template(graph, node, path, idx + 1, Some(field), &inner)
		}
		Step::Variant { node, variant } => {
			let inner = render_at(graph, path, idx + 1);
			let parent_tmpl = templates::template(node);
			if parent_tmpl == "{variant}" || parent_tmpl.is_empty() {
				let next_step = path.get(idx + 1);
				if matches!(next_step, Some(Step::Field { node: vn, .. }) if vn == variant) {
					inner
				} else if matches!(next_step, Some(Step::Leaf)) {
					inner
				} else {
					inner
				}
			} else {
				fill_template(graph, node, path, idx + 1, Some("variant"), &inner)
			}
		}
	}
}

fn fill_template(
	graph: &AstGraph,
	node: &'static str,
	path: &[Step],
	next_idx: usize,
	chosen_hole: Option<&str>,
	inner: &str,
) -> String {
	let tmpl = templates::template(node);

	let mut out = String::with_capacity(tmpl.len() + inner.len());
	let mut rest = tmpl;
	while let Some(open) = rest.find('{') {
		out.push_str(&rest[..open]);
		rest = &rest[open + 1..];
		if rest.starts_with('{') {
			out.push('{');
			rest = &rest[1..];
			continue;
		}
		let Some(close) = rest.find('}') else {
			out.push('{');
			break;
		};
		let hole = &rest[..close];
		rest = &rest[close + 1..];

		if Some(hole) == chosen_hole {
			out.push_str(inner);
		} else {
			out.push_str(&placeholder_for_hole(graph, node, hole));
		}
		let _ = next_idx;
		let _ = path;
	}
	out.push_str(rest);
	out.replace("}}", "}")
}

fn placeholder_for_hole(graph: &AstGraph, node: &'static str, hole: &str) -> String {
	let Some(def) = graph.nodes.get(node) else {
		return String::new();
	};
	if let Some(f) = def.fields.iter().find(|f| f.name == hole) {
		let p = templates::placeholder(f.ty);
		match f.card {
			Cardinality::One | Cardinality::Vec => p.to_string(),
			Cardinality::Opt => String::new(),
		}
	} else if hole == "variant" {
		if def.variants.is_empty() {
			String::new()
		} else {
			let v = def.variants[0];
			templates::placeholder(v).to_string()
		}
	} else {
		String::new()
	}
}
