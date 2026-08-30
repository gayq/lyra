export type LifecycleHooks = {
	navigate: {
		context: {
			type: "location" | "history" | "hashchange" | "popstate";
		};
		props: {
			url: string;
		};
	};
};
