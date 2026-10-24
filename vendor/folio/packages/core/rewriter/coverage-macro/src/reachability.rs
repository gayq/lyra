use std::collections::{HashMap, HashSet};

use crate::ast_table::{Cardinality, Field, NODES, NodeDef};

#[derive(Clone, Debug)]
pub struct AstGraph {
	pub nodes: HashMap<&'static str, &'static NodeDef>,
	pub reaches_expression: HashSet<&'static str>,
}

impl AstGraph {
	pub fn build() -> Self {
		let mut nodes = HashMap::new();
		for n in NODES {
			nodes.insert(n.name, n);
		}

		let mut r: HashSet<&'static str> = HashSet::new();
		r.insert("Expression");
		r.insert("IdentifierReference");

		loop {
			let mut changed = false;
			for n in NODES {
				if r.contains(n.name) {
					continue;
				}
				let mut hit = false;
				for v in n.variants {
					if r.contains(v) {
						hit = true;
						break;
					}
				}
				if !hit {
					for f in n.fields {
						if r.contains(f.ty) {
							hit = true;
							break;
						}
					}
				}
				if hit {
					r.insert(n.name);
					changed = true;
				}
			}
			if !changed {
				break;
			}
		}

		Self {
			nodes,
			reaches_expression: r,
		}
	}

	pub fn in_r(&self, ty: &str) -> bool {
		self.reaches_expression.contains(ty)
	}

	pub fn field_in_r(&self, f: &Field) -> bool {
		let _ = Cardinality::One;
		self.in_r(f.ty)
	}
}
