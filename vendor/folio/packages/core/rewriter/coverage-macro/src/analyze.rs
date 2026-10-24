use std::collections::{BTreeSet, HashMap};
use proc_macro2::TokenStream;
use syn::{Block, Expr, ExprForLoop, ExprIf, ExprMatch, Pat, Stmt};
use crate::helper_index::{
	Binding, HelperInfo, Origin, OriginMap, iter_element_type, origin_from_iter, resolve_origin,
	resolve_type,
};
use crate::reachability::AstGraph;

#[derive(Clone, Debug)]
pub struct Covered {
	pub all: bool,
	pub fields: BTreeSet<String>,
}

impl Covered {
	pub fn empty() -> Self {
		Self {
			all: false,
			fields: BTreeSet::new(),
		}
	}
	pub fn full() -> Self {
		Self {
			all: true,
			fields: BTreeSet::new(),
		}
	}
	pub fn add_field(&mut self, name: &str) {
		self.fields.insert(name.to_string());
	}
	pub fn intersect(a: &Self, b: &Self) -> Self {
		if a.all && b.all {
			return Self::full();
		}
		let af: BTreeSet<String> = if a.all {
			b.fields.clone()
		} else {
			a.fields.clone()
		};
		let bf: BTreeSet<String> = if b.all {
			a.fields.clone()
		} else {
			b.fields.clone()
		};
		Self {
			all: a.all && b.all,
			fields: af.intersection(&bf).cloned().collect(),
		}
	}
	pub fn covers(&self, name: &str) -> bool {
		self.all || self.fields.iter().any(|f| f == name)
	}
}

#[derive(Clone, Debug)]
pub struct Witness {
	pub kind: PathKind,
	pub covered: Covered,
}

#[derive(Clone, Debug)]
pub enum PathKind {
	FallThrough,
	Return,
}

#[derive(Default)]
pub struct Findings {
	pub missing: Vec<MissingCover>,
	pub bad_skips: Vec<BadSkip>,
}

#[derive(Clone, Debug)]
pub struct MissingCover {
	pub field: String,
	pub field_ty: String,
	pub path_label: String,
}

#[derive(Clone, Debug)]
pub struct BadSkip {
	pub field: String,
	pub field_ty: String,
	pub site_repr: String,
}

pub fn analyze(body: &Block, _findings: &mut Findings, graph: &AstGraph) -> Vec<Witness> {
	let helpers = HashMap::new();
	let origins = OriginMap::new();
	analyze_with_helpers_typed(body, "it", None, &helpers, graph, origins)
}

pub fn analyze_with_helpers(
	body: &Block,
	it_name: &str,
	helpers: &HashMap<String, HelperInfo>,
	graph: &AstGraph,
	origins: OriginMap,
) -> Vec<Witness> {
	analyze_with_helpers_typed(body, it_name, None, helpers, graph, origins)
}

pub fn analyze_with_helpers_typed(
	body: &Block,
	it_name: &str,
	it_node_type: Option<&str>,
	helpers: &HashMap<String, HelperInfo>,
	graph: &AstGraph,
	mut origins: OriginMap,
) -> Vec<Witness> {
	if let Some(t) = it_node_type {
		origins.set_binding(it_name, Binding::it(Some(t.to_string())));
	}
	let mut completed: Vec<Witness> = Vec::new();
	let ctx = Ctx {
		it_name,
		it_node_type,
		helpers,
		graph,
	};
	let final_cov = walk_block(body, Covered::empty(), origins, &mut completed, &ctx);
	completed.push(Witness {
		kind: PathKind::FallThrough,
		covered: final_cov,
	});
	completed
}

struct Ctx<'a> {
	it_name: &'a str,
	it_node_type: Option<&'a str>,
	helpers: &'a HashMap<String, HelperInfo>,
	graph: &'a AstGraph,
}

fn walk_block(
	block: &Block,
	mut cov: Covered,
	mut origins: OriginMap,
	completed: &mut Vec<Witness>,
	ctx: &Ctx,
) -> Covered {
	for stmt in &block.stmts {
		let out = walk_stmt(stmt, cov.clone(), &mut origins, completed, ctx);
		match out {
			Out::Continue(c) => cov = c,
			Out::Terminated => return Covered::full(),
		}
	}
	cov
}

enum Out {
	Continue(Covered),
	Terminated,
}

fn walk_stmt(
	stmt: &Stmt,
	cov: Covered,
	origins: &mut OriginMap,
	completed: &mut Vec<Witness>,
	ctx: &Ctx,
) -> Out {
	match stmt {
		Stmt::Expr(e, _) => walk_expr_stmt(e, cov, origins, completed, ctx),
		Stmt::Local(loc) => {
			if let Some(init) = &loc.init {
				let (new_cov, terminated) =
					inspect_expr(&init.expr, cov.clone(), origins, completed, ctx);
				if let Pat::Ident(pid) = &loc.pat {
					let name = pid.ident.to_string();
					let origin = resolve_origin(&init.expr, origins, ctx.it_name);
					let ty = resolve_type(
						&init.expr,
						origins,
						ctx.it_name,
						ctx.it_node_type,
						ctx.graph,
					);
					origins.set_binding(
						&name,
						Binding {
							origin,
							ast_type: ty,
						},
					);
				}
				if terminated {
					return Out::Terminated;
				}
				return Out::Continue(new_cov);
			}
			Out::Continue(cov)
		}
		Stmt::Item(_) => Out::Continue(cov),
		Stmt::Macro(m) => Out::Continue(handle_macro_invocation(&m.mac, cov)),
	}
}

fn walk_expr_stmt(
	expr: &Expr,
	cov: Covered,
	origins: &mut OriginMap,
	completed: &mut Vec<Witness>,
	ctx: &Ctx,
) -> Out {
	let (new_cov, terminated) = inspect_expr(expr, cov, origins, completed, ctx);
	if terminated {
		Out::Terminated
	} else {
		Out::Continue(new_cov)
	}
}

fn inspect_expr(
	expr: &Expr,
	mut cov: Covered,
	origins: &mut OriginMap,
	completed: &mut Vec<Witness>,
	ctx: &Ctx,
) -> (Covered, bool) {
	match expr {
		Expr::Return(_) => {
			completed.push(Witness {
				kind: PathKind::Return,
				covered: cov,
			});
			(Covered::full(), true)
		}
		Expr::Break(_) | Expr::Continue(_) => {
			(Covered::full(), true)
		}
		Expr::Try(t) => {
			inspect_expr(&t.expr, cov, origins, completed, ctx)
		}
		Expr::Macro(m) => {
			if is_terminating_macro(&m.mac) {
				return (Covered::full(), true);
			}
			(handle_macro_invocation(&m.mac, cov), false)
		}
		Expr::If(eif) => (walk_if(eif, cov, origins, completed, ctx), false),
		Expr::Match(em) => (walk_match(em, &cov, origins, completed, ctx), false),
		Expr::Block(b) => (
			walk_block(&b.block, cov, origins.clone(), completed, ctx),
			false,
		),
		Expr::Unsafe(b) => (
			walk_block(&b.block, cov, origins.clone(), completed, ctx),
			false,
		),
		Expr::ForLoop(efl) => {
			cov = walk_for_loop(efl, cov, origins.clone(), completed, ctx);
			(cov, false)
		}
		Expr::While(ew) => {
			let _ = walk_block(&ew.body, cov.clone(), origins.clone(), completed, ctx);
			(cov, false)
		}
		Expr::Loop(el) => {
			let _ = walk_block(&el.body, cov.clone(), origins.clone(), completed, ctx);
			(cov, false)
		}
		Expr::Call(call) => {
			cov = handle_call(call, cov, origins, ctx);
			(cov, false)
		}
		Expr::MethodCall(mc) => {
			cov = handle_method_call(mc, cov, origins, ctx);
			(cov, false)
		}
		Expr::Assign(a) => {
			let (c, _) = inspect_expr(&a.right, cov, origins, completed, ctx);
			(c, false)
		}
		_ => (cov, false),
	}
}

fn walk_if(
	eif: &ExprIf,
	cov: Covered,
	origins: &mut OriginMap,
	completed: &mut Vec<Witness>,
	ctx: &Ctx,
) -> Covered {
	let mut then_origins = origins.clone();
	let mut scrut_field: Option<String> = None;
	let mut scrut_type: Option<String> = None;
	let mut scrut_origin = Origin::Unknown;
	let mut scrut_variant: Option<String> = None;
	let mut scrut_expr_for_if_let: Option<&Expr> = None;
	if let Expr::Let(el) = eif.cond.as_ref() {
		bind_pattern_origins(&el.pat, &el.expr, &mut then_origins, ctx);
		scrut_origin = resolve_origin(&el.expr, origins, ctx.it_name);
		if let Origin::Field(name) = &scrut_origin {
			scrut_field = Some(name.clone());
		}
		scrut_type = resolve_type(&el.expr, origins, ctx.it_name, ctx.it_node_type, ctx.graph);
		scrut_variant = pattern_variant_name(&el.pat, ctx);
		scrut_expr_for_if_let = Some(&el.expr);
	}
	let then_cov = walk_block(&eif.then_branch, cov.clone(), then_origins, completed, ctx);
	if let (Some(variant), Some(ty), Some(scrut_e)) =
		(&scrut_variant, &scrut_type, scrut_expr_for_if_let)
		&& let Some(def) = ctx.graph.nodes.get(ty.as_str())
		&& !def.variants.is_empty()
	{
		let variant_covered =
			if_let_variant_covered(&then_cov, &eif.then_branch, variant, scrut_e, ctx);

		let other_variants_covered = else_covers_other_variants(
			eif.else_branch.as_ref().map(|(_, e)| e.as_ref()),
			ty.as_str(),
			variant,
			scrut_e,
			cov.clone(),
			origins,
			completed,
			ctx,
		);

		if variant_covered && other_variants_covered {
			let mut c = cov;
			if then_cov.all {
				c.all = true;
			} else {
				for f in &then_cov.fields {
					c.fields.insert(f.clone());
				}
			}
			if let Some(field_name) = &scrut_field {
				c.add_field(field_name);
			} else if matches!(scrut_origin, Origin::It) {
				c.all = true;
			}
			return c;
		}
	}

	match &eif.else_branch {
		Some((_, e)) => {
			let else_cov = match e.as_ref() {
				Expr::Block(b) => {
					walk_block(&b.block, cov.clone(), origins.clone(), completed, ctx)
				}
				Expr::If(inner) => walk_if(inner, cov.clone(), origins, completed, ctx),
				_ => cov.clone(),
			};
			Covered::intersect(&then_cov, &else_cov)
		}
		None => {
			if let Some(f) = &scrut_field {
				let mut c = then_cov;
				c.add_field(f);
				c
			} else {
				cov
			}
		}
	}
}

fn pattern_variant_name(pat: &Pat, ctx: &Ctx) -> Option<String> {
	match pat {
		Pat::TupleStruct(ts) => {
			let last = ts.path.segments.last()?.ident.to_string();
			if ctx.graph.nodes.contains_key(last.as_str()) {
				Some(last)
			} else {
				None
			}
		}
		Pat::Struct(s) => {
			let last = s.path.segments.last()?.ident.to_string();
			if ctx.graph.nodes.contains_key(last.as_str()) {
				Some(last)
			} else {
				None
			}
		}
		Pat::Reference(r) => pattern_variant_name(&r.pat, ctx),
		Pat::Paren(p) => pattern_variant_name(&p.pat, ctx),
		_ => None,
	}
}

fn if_let_variant_covered(
	then_cov: &Covered,
	then_block: &Block,
	variant: &str,
	scrut_expr: &Expr,
	ctx: &Ctx,
) -> bool {
	if then_cov.all {
		return true;
	}
	if then_cov.fields.iter().any(|n| n == variant) {
		return true;
	}
	if scan_block_for_helper_on(then_block, scrut_expr, variant, ctx) {
		return true;
	}
	false
}

#[allow(clippy::too_many_arguments)]
fn else_covers_other_variants(
	else_expr: Option<&Expr>,
	enum_ty: &str,
	matched_variant: &str,
	scrut_expr: &Expr,
	cov: Covered,
	origins: &mut OriginMap,
	completed: &mut Vec<Witness>,
	ctx: &Ctx,
) -> bool {
	let Some(else_expr) = else_expr else {
		return false;
	};
	let Some(def) = ctx.graph.nodes.get(enum_ty) else {
		return false;
	};

	let else_block = match else_expr {
		Expr::Block(b) => b.block.clone(),
		Expr::If(inner) => {
			syn::Block {
				brace_token: syn::token::Brace::default(),
				stmts: vec![Stmt::Expr(Expr::If(inner.clone()), None)],
			}
		}
		other => syn::Block {
			brace_token: syn::token::Brace::default(),
			stmts: vec![Stmt::Expr(other.clone(), None)],
		},
	};
	let else_cov = walk_block(&else_block, cov, origins.clone(), completed, ctx);

	for v in def.variants {
		if !ctx.graph.in_r(v) {
			continue;
		}
		if *v == matched_variant {
			continue;
		}
		if else_cov.all {
			continue;
		}
		if else_cov.fields.iter().any(|n| n == v) {
			continue;
		}
		if scan_block_for_helper_on(&else_block, scrut_expr, v, ctx) {
			continue;
		}
		return false;
	}
	true
}

fn scan_block_for_helper_on(block: &Block, scrut_expr: &Expr, variant: &str, ctx: &Ctx) -> bool {
	let scrut_repr = expr_canonical(scrut_expr);
	let mut hit = false;
	for stmt in &block.stmts {
		if let Stmt::Expr(e, _) = stmt {
			scan_helper_calls(e, &mut |mc| {
				let Expr::Path(p) = mc.receiver.as_ref() else {
					return;
				};
				if !p.path.is_ident("self") {
					return;
				}
				let name = mc.method.to_string();
				let Some(info) = ctx.helpers.get(&name) else {
					return;
				};
				if !info.covered_set.contains(variant) && !info.covered_all {
					return;
				}
				let Some(arg0) = mc.args.first() else { return };
				if expr_canonical(arg0) == scrut_repr || ref_canonical(arg0) == scrut_repr {
					hit = true;
				}
			});
		}
		if hit {
			break;
		}
	}
	hit
}

fn walk_match(
	em: &ExprMatch,
	cov: &Covered,
	origins: &mut OriginMap,
	completed: &mut Vec<Witness>,
	ctx: &Ctx,
) -> Covered {
	let scrut_origin = resolve_origin(&em.expr, origins, ctx.it_name);
	let scrut_field = match &scrut_origin {
		Origin::Field(name) => Some(name.clone()),
		_ => None,
	};
	let scrut_type = resolve_type(&em.expr, origins, ctx.it_name, ctx.it_node_type, ctx.graph);

	let mut arm_covs = Vec::new();
	for arm in &em.arms {
		let mut arm_origins = origins.clone();
		bind_pattern_origins(&arm.pat, &em.expr, &mut arm_origins, ctx);
		let mut arm_cov = cov.clone();
		match arm.body.as_ref() {
			Expr::Block(b) => {
				arm_cov = walk_block(&b.block, arm_cov, arm_origins, completed, ctx);
			}
			other => {
				let (c, terminated) =
					inspect_expr(other, arm_cov.clone(), &mut arm_origins, completed, ctx);
				arm_cov = if terminated { Covered::full() } else { c };
			}
		}
		arm_covs.push(arm_cov);
	}

	let mut base = {
		let mut it = arm_covs.clone().into_iter();
		let first = it.next().unwrap_or_else(Covered::full);
		it.fold(first, |acc, c| Covered::intersect(&acc, &c))
	};

	if let Some(t) = scrut_type.as_deref()
		&& let Some(def) = ctx.graph.nodes.get(t)
		&& !def.variants.is_empty()
	{
		let mut all_covered = true;
		for v in def.variants {
			if !ctx.graph.in_r(v) {
				continue;
			}
			let arm = find_arm_for_variant(em, v);
			let covered = arm.is_some_and(|a| arm_covers_variant(a, v, &em.expr, ctx));
			if covered {
				base.add_field(v);
			} else {
				all_covered = false;
			}
		}
		if all_covered {
			if let Some(field_name) = &scrut_field {
				base.add_field(field_name);
			} else if matches!(scrut_origin, Origin::It) {
				base.all = true;
			}
		}
	}

	base
}

#[allow(dead_code)]
fn check_match_covers_enum(
	em: &ExprMatch,
	enum_def: &crate::ast_table::NodeDef,
	ctx: &Ctx,
) -> bool {
	use crate::ast_table::NodeDef;

	let mut needed: Vec<&str> = Vec::new();
	for v in enum_def.variants {
		if ctx.graph.in_r(v) {
			needed.push(*v);
		}
	}

	for variant in &needed {
		let arm = find_arm_for_variant(em, variant);
		let Some(arm) = arm else {
			return false;
		};
		if !arm_covers_variant(arm, variant, &em.expr, ctx) {
			return false;
		}
	}
	let _: &NodeDef = enum_def;
	true
}

fn find_arm_for_variant<'a>(em: &'a ExprMatch, variant: &str) -> Option<&'a syn::Arm> {
	em.arms
		.iter()
		.find(|&arm| arm_matches_variant(&arm.pat, variant))
		.map(|v| v as _)
}

fn arm_matches_variant(pat: &Pat, variant: &str) -> bool {
	match pat {
		Pat::Wild(_) => true,
		Pat::Ident(p) if p.ident == "_" => true,
		Pat::TupleStruct(ts) => {
			ts.path.segments.last().is_some_and(|s| s.ident == variant)
		}
		Pat::Path(p) => p.path.segments.last().is_some_and(|s| s.ident == variant),
		Pat::Struct(s) => s.path.segments.last().is_some_and(|s| s.ident == variant),
		Pat::Or(o) => o.cases.iter().any(|c| arm_matches_variant(c, variant)),
		Pat::Paren(p) => arm_matches_variant(&p.pat, variant),
		Pat::Reference(r) => arm_matches_variant(&r.pat, variant),
		_ => false,
	}
}

fn arm_covers_variant(arm: &syn::Arm, variant: &str, scrut_expr: &Expr, ctx: &Ctx) -> bool {
	let v_def = ctx.graph.nodes.get(variant);
	let binding = extract_arm_binding(&arm.pat);

	if binding.is_none() {
		if let Some(d) = v_def {
			let has_r_field = d.fields.iter().any(|f| ctx.graph.field_in_r(f));
			let has_r_variant = d.variants.iter().any(|v| ctx.graph.in_r(v));
			if !has_r_field && !has_r_variant {
				return true;
			}
		}
		let body_block = match arm.body.as_ref() {
			Expr::Block(b) => b.block.clone(),
			other => syn::Block {
				brace_token: syn::token::Brace::default(),
				stmts: vec![Stmt::Expr(other.clone(), None)],
			},
		};
		let paths = analyze_with_helpers_typed(
			&body_block,
			ctx.it_name,
			ctx.it_node_type,
			ctx.helpers,
			ctx.graph,
			OriginMap::new(),
		);
		if paths.iter().all(|p| p.covered.all) {
			return true;
		}
		return body_covers_variant_via_helper(arm, scrut_expr, variant, ctx);
	}

	let bname = binding.unwrap();
	let Some(v_def) = v_def else { return false };

	let body_block = match arm.body.as_ref() {
		Expr::Block(b) => b.block.clone(),
		other => syn::Block {
			brace_token: syn::token::Brace::default(),
			stmts: vec![Stmt::Expr(other.clone(), None)],
		},
	};
	let mut origins = OriginMap::new();
	origins.set_binding(&bname, Binding::it(Some(variant.to_string())));
	let paths = analyze_with_helpers_typed(
		&body_block,
		&bname,
		Some(variant),
		ctx.helpers,
		ctx.graph,
		origins,
	);

	for p in &paths {
		if !p.covered.all {
			if v_def.fields.is_empty() && !v_def.variants.is_empty() {
				return false;
			}
			for f in v_def.fields {
				if !ctx.graph.field_in_r(f) {
					continue;
				}
				if !p.covered.fields.iter().any(|n| n == f.name) {
					return false;
				}
			}
		}
	}
	true
}

fn body_covers_variant_via_helper(
	arm: &syn::Arm,
	scrut_expr: &Expr,
	variant: &str,
	ctx: &Ctx,
) -> bool {
	let scrut_repr = expr_canonical(scrut_expr);
	let body = arm.body.as_ref();
	let mut hit = false;
	scan_helper_calls(body, &mut |mc| {
		let Expr::Path(p) = mc.receiver.as_ref() else {
			return;
		};
		if !p.path.is_ident("self") {
			return;
		}
		let name = mc.method.to_string();
		let Some(info) = ctx.helpers.get(&name) else {
			return;
		};
		if !info.covered_set.contains(variant) && !info.covered_all {
			return;
		}
		let Some(arg0) = mc.args.first() else { return };
		if expr_canonical(arg0) == scrut_repr || ref_canonical(arg0) == scrut_repr {
			hit = true;
		}
	});
	hit
}

fn expr_canonical(e: &Expr) -> String {
	use quote::ToTokens;
	e.to_token_stream().to_string()
}

fn ref_canonical(e: &Expr) -> String {
	if let Expr::Reference(r) = e {
		return expr_canonical(&r.expr);
	}
	expr_canonical(e)
}

fn scan_helper_calls<F: FnMut(&syn::ExprMethodCall)>(e: &Expr, f: &mut F) {
	match e {
		Expr::MethodCall(m) => {
			f(m);
			scan_helper_calls(&m.receiver, f);
			for a in &m.args {
				scan_helper_calls(a, f);
			}
		}
		Expr::Call(c) => {
			scan_helper_calls(&c.func, f);
			for a in &c.args {
				scan_helper_calls(a, f);
			}
		}
		Expr::Block(b) => {
			for s in &b.block.stmts {
				if let Stmt::Expr(e, _) = s {
					scan_helper_calls(e, f);
				}
			}
		}
		Expr::If(eif) => {
			for s in &eif.then_branch.stmts {
				if let Stmt::Expr(e, _) = s {
					scan_helper_calls(e, f);
				}
			}
			if let Some((_, els)) = &eif.else_branch {
				scan_helper_calls(els, f);
			}
		}
		Expr::Match(em) => {
			for arm in &em.arms {
				scan_helper_calls(&arm.body, f);
			}
		}
		Expr::Paren(p) => scan_helper_calls(&p.expr, f),
		Expr::Reference(r) => scan_helper_calls(&r.expr, f),
		_ => {}
	}
}

fn extract_arm_binding(pat: &Pat) -> Option<String> {
	match pat {
		Pat::Ident(p) if p.ident == "_" => None,
		Pat::Ident(p) => Some(p.ident.to_string()),
		Pat::TupleStruct(ts) => {
			if let Some(inner) = ts.elems.first() {
				return extract_arm_binding(inner);
			}
			None
		}
		Pat::Tuple(t) => {
			if let Some(inner) = t.elems.first() {
				return extract_arm_binding(inner);
			}
			None
		}
		Pat::Struct(s) => {
			if let Some(f) = s.fields.first() {
				return extract_arm_binding(&f.pat);
			}
			None
		}
		Pat::Reference(r) => extract_arm_binding(&r.pat),
		Pat::Paren(p) => extract_arm_binding(&p.pat),
		_ => None,
	}
}

fn walk_for_loop(
	efl: &ExprForLoop,
	mut cov: Covered,
	mut origins: OriginMap,
	completed: &mut Vec<Witness>,
	ctx: &Ctx,
) -> Covered {
	if let Pat::Ident(pid) = efl.pat.as_ref() {
		let name = pid.ident.to_string();
		let origin = origin_from_iter(&efl.expr, &origins, ctx.it_name);
		let ty = iter_element_type(
			&efl.expr,
			&origins,
			ctx.it_name,
			ctx.it_node_type,
			ctx.graph,
		);
		origins.set_binding(
			&name,
			Binding {
				origin,
				ast_type: ty,
			},
		);
	}
	let body_cov = walk_block(&efl.body, Covered::empty(), origins.clone(), completed, ctx);
	if body_cov.all {
		cov.all = true;
	} else {
		for f in &body_cov.fields {
			cov.fields.insert(f.clone());
		}
	}
	cov
}

fn bind_pattern_origins(pat: &Pat, scrut: &Expr, origins: &mut OriginMap, ctx: &Ctx) {
	let scrut_origin = resolve_origin(scrut, origins, ctx.it_name);
	let scrut_type = resolve_type(scrut, origins, ctx.it_name, ctx.it_node_type, ctx.graph);
	bind_pat_with(pat, &scrut_origin, scrut_type.as_deref(), origins, ctx);
}

fn bind_pat_with(
	pat: &Pat,
	origin: &Origin,
	scrut_ty: Option<&str>,
	origins: &mut OriginMap,
	ctx: &Ctx,
) {
	match pat {
		Pat::Ident(p) => {
			origins.set_binding(
				&p.ident.to_string(),
				Binding {
					origin: origin.clone(),
					ast_type: scrut_ty.map(String::from),
				},
			);
			if let Some((_, sub)) = &p.subpat {
				bind_pat_with(sub, origin, scrut_ty, origins, ctx);
			}
		}
		Pat::Reference(r) => bind_pat_with(&r.pat, origin, scrut_ty, origins, ctx),
		Pat::TupleStruct(ts) => {
			let variant_name = ts.path.segments.last().map(|s| s.ident.to_string());
			let variant_ty = variant_name
				.as_deref()
				.filter(|n| ctx.graph.nodes.contains_key(*n))
				.map(String::from);
			let inner_ty = variant_ty.as_deref().or(scrut_ty);
			for elem in &ts.elems {
				bind_pat_with(elem, origin, inner_ty, origins, ctx);
			}
		}
		Pat::Tuple(t) => {
			for elem in &t.elems {
				bind_pat_with(elem, origin, scrut_ty, origins, ctx);
			}
		}
		Pat::Struct(s) => {
			let variant_name = s.path.segments.last().map(|s| s.ident.to_string());
			let variant_ty = variant_name
				.as_deref()
				.filter(|n| ctx.graph.nodes.contains_key(*n))
				.map(String::from);
			let inner_ty = variant_ty.as_deref().or(scrut_ty);
			for f in &s.fields {
				bind_pat_with(&f.pat, origin, inner_ty, origins, ctx);
			}
		}
		Pat::Or(o) => {
			for case in &o.cases {
				bind_pat_with(case, origin, scrut_ty, origins, ctx);
			}
		}
		Pat::Paren(p) => bind_pat_with(&p.pat, origin, scrut_ty, origins, ctx),
		Pat::Slice(s) => {
			for elem in &s.elems {
				bind_pat_with(elem, origin, scrut_ty, origins, ctx);
			}
		}
		_ => {}
	}
}

fn handle_call(call: &syn::ExprCall, mut cov: Covered, origins: &OriginMap, ctx: &Ctx) -> Covered {
	let Expr::Path(p) = call.func.as_ref() else {
		return cov;
	};
	let segs: Vec<String> = p
		.path
		.segments
		.iter()
		.map(|s| s.ident.to_string())
		.collect();
	if segs.len() < 2 || segs[0] != "walk" || !segs[1].starts_with("walk_") {
		return cov;
	}
	if call.args.len() < 2 {
		return cov;
	}
	let target = &call.args[1];
	apply_origin_to_cov_typed(
		target,
		origins,
		ctx.it_name,
		ctx.it_node_type,
		Some(ctx.graph),
		&mut cov,
		true,
	);
	cov
}

fn handle_method_call(
	mc: &syn::ExprMethodCall,
	mut cov: Covered,
	origins: &OriginMap,
	ctx: &Ctx,
) -> Covered {
	let Expr::Path(p) = mc.receiver.as_ref() else {
		return cov;
	};
	if !p.path.is_ident("self") {
		return cov;
	}
	let name = mc.method.to_string();
	let Some(info) = ctx.helpers.get(&name) else {
		return cov;
	};
	let call_args: Vec<&Expr> = mc.args.iter().collect();
	for ha in &info.args {
		if !ha.fully_covers {
			continue;
		}
		let Some(call_arg) = call_args.get(ha.call_pos) else {
			continue;
		};
		apply_origin_to_cov_typed(
			call_arg,
			origins,
			ctx.it_name,
			ctx.it_node_type,
			Some(ctx.graph),
			&mut cov,
			true,
		);
	}
	cov
}

fn apply_origin_to_cov(
	e: &Expr,
	origins: &OriginMap,
	it_name: &str,
	cov: &mut Covered,
	all_if_root: bool,
) {
	apply_origin_to_cov_typed(e, origins, it_name, None, None, cov, all_if_root);
}

fn apply_origin_to_cov_typed(
	e: &Expr,
	origins: &OriginMap,
	it_name: &str,
	it_node_type: Option<&str>,
	graph: Option<&AstGraph>,
	cov: &mut Covered,
	all_if_root: bool,
) {
	let o = resolve_origin(e, origins, it_name);
	match o {
		Origin::It => {
			if !all_if_root {
				return;
			}
			let arg_ty = graph.and_then(|g| {
				crate::helper_index::resolve_type(e, origins, it_name, it_node_type, g)
			});
			match (arg_ty.as_deref(), it_node_type) {
				(Some(at), Some(ot)) if at == ot => cov.all = true,
				(Some(at), Some(ot)) => {
					let is_variant = graph
						.and_then(|g| g.nodes.get(ot))
						.is_some_and(|d| d.variants.contains(&at));
					if is_variant {
						cov.add_field(at);
					} else {
						cov.all = true;
					}
				}
				_ => cov.all = true,
			}
		}
		Origin::Field(name) => cov.add_field(&name),
		Origin::Unknown => {}
	}
}

fn is_terminating_macro(mac: &syn::Macro) -> bool {
	let name = mac
		.path
		.segments
		.last()
		.map(|s| s.ident.to_string())
		.unwrap_or_default();
	matches!(
		name.as_str(),
		"panic" | "unreachable" | "todo" | "unimplemented"
	)
}

fn handle_macro_invocation(mac: &syn::Macro, mut cov: Covered) -> Covered {
	let name = mac
		.path
		.segments
		.iter()
		.next_back()
		.map(|s| s.ident.to_string())
		.unwrap_or_default();
	match name.as_str() {
		"walk_all" => cov.all = true,
		"walk_field" | "walk_field_ctx" | "skip_field" => {
			if let Some(f) = extract_field_name(&mac.tokens) {
				cov.add_field(&f);
			}
		}
		"audit_skip" => {
			if let Some(f) = extract_field_name(&mac.tokens) {
				cov.add_field(&f);
			} else {
				cov.all = true;
			}
		}
		_ => {}
	}
	cov
}

pub fn extract_field_name(ts: &TokenStream) -> Option<String> {
	use proc_macro2::TokenTree;
	let toks: Vec<TokenTree> = ts.clone().into_iter().collect();
	let mut last: Option<String> = None;
	let mut i = 0;
	while i + 2 < toks.len() {
		if let (TokenTree::Ident(a), TokenTree::Punct(p), TokenTree::Ident(c)) =
			(&toks[i], &toks[i + 1], &toks[i + 2])
			&& a == "it"
			&& p.as_char() == '.'
		{
			last = Some(c.to_string());
			i += 3;
			continue;
		}
		i += 1;
	}
	last
}

pub fn extract_receiver_and_field(ts: &TokenStream) -> Option<(syn::Ident, String)> {
	use proc_macro2::TokenTree;
	let toks: Vec<TokenTree> = ts.clone().into_iter().collect();
	let mut found = None;
	let mut i = 0;
	while i + 2 < toks.len() {
		if let (TokenTree::Ident(a), TokenTree::Punct(p), TokenTree::Ident(c)) =
			(&toks[i], &toks[i + 1], &toks[i + 2])
			&& p.as_char() == '.'
		{
			found = Some((a.clone(), c.to_string()));
		}
		i += 1;
	}
	found
}
