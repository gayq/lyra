import { readFileSync } from "node:fs";
import vm from "node:vm";

export function loadSource(path, symbol, globals) {
  const source = new Bun.Transpiler({
    loader: path.endsWith("tsx") ? "tsx" : "ts",
  })
    .transformSync(readFileSync(path, "utf8"))
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export default .*;$/gm, "")
    .replace(/^export default (?=function\b)/gm, "")
    .replace(/^export /gm, "")
    .replace(/\b(jsxDEV|Fragment)_\w+\b/g, "$1");
  const context = vm.createContext(globals);
  vm.runInContext(`${source}\nglobalThis.subject = ${symbol};`, context);
  return context.subject;
}

export function hookHost() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let dirty = false;
  let output;
  const changed = (previous, next) =>
    !previous ||
    next.some((value, index) => !Object.is(value, previous[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index])
        slots[index] = {
          value: typeof initial === "function" ? initial() : initial,
        };
      return [
        slots[index].value,
        (update) => {
          const value =
            typeof update === "function" ? update(slots[index].value) : update;
          if (!Object.is(value, slots[index].value)) {
            slots[index].value = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(value) {
      const index = cursor++;
      slots[index] ||= { current: value };
      return slots[index];
    },
    useMemo(create, deps) {
      const index = cursor++;
      if (changed(slots[index]?.deps, deps))
        slots[index] = { value: create(), deps };
      return slots[index].value;
    },
    useCallback(callback, deps) {
      return hooks.useMemo(() => callback, deps);
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (changed(slots[index]?.deps, deps)) {
        effects.push(() => {
          slots[index]?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  return {
    hooks,
    render(component, props, mount = () => {}) {
      let renders = 0;
      do {
        dirty = false;
        cursor = 0;
        effects = [];
        output = component(props);
        mount(output);
        for (const effect of effects) effect();
        if (++renders > 30)
          throw new Error("render did not settle... /ᐠ - ˕ -マ");
      } while (dirty);
      return output;
    },
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
