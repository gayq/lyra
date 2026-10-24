use oxc::{
	ast::ast::AssignmentOperator,
	span::{Atom, Span},
};
use smallvec::{SmallVec, smallvec};

use crate::changes::{JsChange, change};

macro_rules! rewrite {
    ($span:expr, $($ty:tt)*) => {
		$crate::rewrite::Rewrite::new($span, $crate::rewrite::RewriteType::$($ty)*)
    };
}
pub(crate) use rewrite;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RewriteType<'alloc: 'data, 'data> {
	WrapFn {
		enclose: bool,
	},
	WrapPostMessage,

	WrapNew,

	ImportFn,
	MetaFn,

	#[allow(dead_code)]
	SetRealmFn,

	RewriteProperty {
		ident: Atom<'data>,
	},

	RebindProperty {
		ident: Atom<'data>,
		tempvar: bool,
	},
	TempVar,

	WrapObjectAssignment {
		restids: Vec<Atom<'data>>,
		location_assigned: bool,
	},

	WrapProperty,

	#[allow(dead_code)]
	ScramErr {
		ident: Atom<'data>,
	},
	Scramitize,

	Eval {
		inner: Span,
	},
	Assignment {
		name: Atom<'data>,
		rhs: Span,
		op: AssignmentOperator,
	},
	ShorthandObj {
		name: Atom<'data>,
	},
	SourceTag,

	CleanFunction {
		restids: Vec<Atom<'data>>,
		expression: bool,
		location_assigned: bool,
		wrap: bool,
		declare_local_location: bool,
	},
	CleanVariableDeclaration {
		restids: Vec<Atom<'data>>,
		location_assigned: bool,
		declare_local_location: bool,
	},

	Replace {
		text: &'alloc str,
	},
	Delete,
}

#[derive(Debug)]
pub(crate) struct Rewrite<'alloc, 'data> {
	span: Span,
	ty: RewriteType<'alloc, 'data>,
}

impl<'alloc: 'data, 'data> Rewrite<'alloc, 'data> {
	pub fn new(span: Span, ty: RewriteType<'alloc, 'data>) -> Self {
		Self { span, ty }
	}

	pub fn into_inner(self) -> SmallVec<[JsChange<'alloc, 'data>; 2]> {
		self.ty.into_inner(self.span)
	}
}

impl<'alloc: 'data, 'data> RewriteType<'alloc, 'data> {
	#[allow(clippy::too_many_lines)]
	fn into_inner(self, span: Span) -> SmallVec<[JsChange<'alloc, 'data>; 2]> {
		macro_rules! span {
			(start) => {
				Span::new(span.start, span.start)
			};
			(end) => {
				Span::new(span.end, span.end)
			};
			($span1:ident $span2:ident start) => {
				Span::new($span1.start, $span2.start)
			};
			($span1:ident $span2:ident end) => {
				Span::new($span1.end, $span2.end)
			};
			($span1:ident $span2:ident between) => {
				Span::new($span1.end, $span2.start)
			};
		}

		match self {
			Self::WrapFn { enclose } => smallvec![
				change!(span!(start), WrapFnLeft { enclose }),
				change!(span!(end), WrapFnRight { enclose }),
			],
			Self::RewriteProperty { ident } => smallvec![change!(span, RewriteProperty { ident }),],
			Self::RebindProperty { ident, tempvar } => {
				smallvec![change!(span, RebindProperty { ident, tempvar })]
			}
			Self::TempVar => smallvec![change!(span, TempVar)],
			Self::WrapProperty => smallvec![
				change!(span!(start), WrapPropertyLeft),
				change!(span!(end), WrapPropertyRight),
			],
			Self::WrapObjectAssignment {
				restids,
				location_assigned,
			} => smallvec![
				change!(
					span!(start),
					WrapObjectAssignmentLeft {
						restids,
						location_assigned
					}
				),
				change!(
					span!(end),
					ClosingParen {
						semi: false,
						replace: false
					}
				)
			],
			Self::CleanFunction {
				restids,
				expression,
				location_assigned,
				wrap,
				declare_local_location,
			} => {
				if expression {
					smallvec![
						change!(
							Span::new(span.start, span.start),
							CleanFunction {
								restids,
								expression,
								location_assigned,
								wrap,
								declare_local_location
							}
						),
						change!(
							Span::new(span.end, span.end),
							ClosingParen {
								semi: false,
								replace: false
							}
						)
					]
				} else if wrap {
					smallvec![
						change!(
							Span::new(span.start, span.start),
							CleanFunction {
								restids,
								expression,
								location_assigned,
								wrap,
								declare_local_location
							}
						),
						change!(
							span!(end),
							ClosingBrace {
								semi: false,
								replace: false
							}
						)
					]
				} else {
					smallvec![change!(
						Span::new(span.start, span.start),
						CleanFunction {
							restids,
							expression,
							location_assigned,
							wrap,
							declare_local_location
						}
					)]
				}
			}
			Self::CleanVariableDeclaration {
				restids,
				location_assigned,
				declare_local_location,
			} => smallvec![change!(
				span!(end),
				CleanVariableDeclaration {
					restids,
					location_assigned,
					declare_local_location
				}
			)],
			Self::WrapPostMessage => smallvec![
				change!(span!(start), WrapPostMessageLeft),
				change!(
					span!(end),
					ClosingParen {
						semi: false,
						replace: false
					}
				)
			],
			Self::WrapNew => smallvec![
				change!(span!(start), OpeningParen),
				change!(
					span!(end),
					ClosingParen {
						semi: false,
						replace: false
					}
				)
			],
			Self::SetRealmFn => smallvec![change!(span, SetRealmFn)],
			Self::ImportFn => smallvec![change!(span, ImportFn)],
			Self::MetaFn => smallvec![change!(span, MetaFn)],
			Self::ScramErr { ident } => smallvec![change!(span!(end), ScramErrFn { ident })],
			Self::Scramitize => smallvec![
				change!(span!(start), ScramitizeFn),
				change!(
					span!(end),
					ClosingParen {
						semi: false,
						replace: false
					}
				)
			],
			Self::Eval { inner } => smallvec![
				change!(Span::new(inner.start, inner.start), EvalRewriteFn),
				change!(
					Span::new(inner.end, inner.end),
					ClosingParen {
						semi: false,
						replace: false,
					}
				)
			],
			Self::Assignment { name, rhs, op } => smallvec![
				change!(span!(span rhs start), AssignmentLeft { name, op }),
				change!(
					span!(rhs span end),
					ClosingParen {
						semi: false,
						replace: true
					}
				)
			],
			Self::ShorthandObj { name } => {
				smallvec![change!(span!(end), ShorthandObj { ident: name })]
			}
			Self::SourceTag => smallvec![change!(span, SourceTag)],
			Self::Replace { text } => smallvec![change!(span, Replace { text })],
			Self::Delete => smallvec![change!(span, Delete)],
		}
	}
}
