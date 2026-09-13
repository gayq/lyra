import type { DNRDecision, DNRRule } from "./types";
import type { ExtensionState, RivetRegistry } from "./registry";

interface CompiledRule {
  rule: DNRRule;
  filter: RegExp | null | undefined;
  domainAnchor: boolean;
}

const compiledRules = new WeakMap<ExtensionState, {
  dynamic: DNRRule[];
  session: DNRRule[];
  static: DNRRule[];
  rules: CompiledRule[];
}>();
const actionPriority = { allow: 4, block: 3, upgradeScheme: 2, redirect: 1, modifyHeaders: 0 };

export function recomputeStaticRules(ext: ExtensionState): void {
  ext.staticRules = [];
  for (const id of ext.enabledRulesetIds) {
    const rules = ext.rulesetRules.get(id);
    if (rules) for (const rule of rules) ext.staticRules.push(rule);
  }
}

function compileRule(rule: DNRRule): CompiledRule {
  const condition = rule.condition;
  let pattern = condition.regexFilter ?? "";
  const domainAnchor = !condition.regexFilter && Boolean(condition.urlFilter?.startsWith("||"));
  if (condition.urlFilter) {
    let source = condition.urlFilter;
    let left = "";
    let right = "";
    if (domainAnchor) {
      left = "^(?:[^./:?#]+\\.)*";
      source = source.slice(2);
    } else if (source.startsWith("|")) {
      left = "^";
      source = source.slice(1);
    }
    if (source.endsWith("|")) {
      right = "$";
      source = source.slice(0, -1);
    }
    pattern = left + source.replace(/[.*+?^$(){}|[\]\\]/g, (char) => {
      if (char === "*") return ".*";
      if (char === "^") return "(?:[^a-zA-Z0-9_.%\\-]|$)";
      return "\\" + char;
    }) + right;
  }
  try {
    return { rule, domainAnchor, filter: new RegExp(pattern, condition.isUrlFilterCaseSensitive ? "" : "i") };
  } catch {
    return { rule, domainAnchor, filter: null };
  }
}

function getRules(ext: ExtensionState): CompiledRule[] {
  const cached = compiledRules.get(ext);
  if (cached?.dynamic === ext.dynamicRules && cached.session === ext.sessionRules && cached.static === ext.staticRules) {
    return cached.rules;
  }
  const rules = [...ext.dynamicRules, ...ext.sessionRules, ...ext.staticRules]
    .sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1) || actionPriority[b.action.type] - actionPriority[a.action.type])
    .map((rule) => ({ rule, filter: undefined, domainAnchor: false }));
  compiledRules.set(ext, { dynamic: ext.dynamicRules, session: ext.sessionRules, static: ext.staticRules, rules });
  return rules;
}

function matchesDomains(host: string, domains: string[] | undefined): boolean {
  return Boolean(host && domains?.some((domain) => {
    const normalized = domain.toLowerCase();
    return host === normalized || host.endsWith("." + normalized);
  }));
}

function ruleMatches(compiled: CompiledRule, requestUrl: string, url: URL, initiatorHost: string, resourceType?: string): boolean {
  const condition = compiled.rule.condition;
  if (condition.resourceTypes?.length && (!resourceType || !condition.resourceTypes.includes(resourceType))) return false;
  if (resourceType && condition.excludedResourceTypes?.includes(resourceType)) return false;
  if (condition.requestDomains?.length && !matchesDomains(url.hostname, condition.requestDomains)) return false;
  if (matchesDomains(url.hostname, condition.excludedRequestDomains)) return false;
  if (condition.initiatorDomains?.length && !matchesDomains(initiatorHost, condition.initiatorDomains)) return false;
  if (matchesDomains(initiatorHost, condition.excludedInitiatorDomains)) return false;
  if (compiled.filter === undefined) Object.assign(compiled, compileRule(compiled.rule));
  return Boolean(compiled.filter?.test(compiled.domainAnchor ? url.host + url.pathname + url.search : requestUrl));
}

interface HeaderOperation {
  header: string;
  operation: "append" | "set" | "remove";
  value?: string;
}

function mergeHeaders(
  target: HeaderOperation[],
  applied: Map<string, { operation: string; extId: string }>,
  operations: unknown[] | undefined,
  extId: string,
): void {
  for (const candidate of operations ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    const op = candidate as HeaderOperation;
    if (typeof op.header !== "string" || !["append", "set", "remove"].includes(op.operation)) continue;
    const name = op.header.toLowerCase();
    const previous = applied.get(name);
    if (previous && (op.operation !== "append" || previous.operation === "remove" ||
      (previous.operation === "set" && previous.extId !== extId))) continue;
    if (!previous) applied.set(name, { operation: op.operation, extId });
    target.push({ ...op });
  }
}

function getRedirectUrl(compiled: CompiledRule, requestUrl: string, url: URL): string | null {
  const { rule, filter } = compiled;
  const action = rule.action;
  let target = action.redirect?.url;
  if (action.type === "upgradeScheme") {
    if (url.protocol !== "http:" && url.protocol !== "ftp:") return null;
    target = requestUrl.replace(/^(?:http|ftp):/, "https:");
  } else if (action.redirect?.regexSubstitution && rule.condition.regexFilter && filter) {
    const match = filter.exec(requestUrl);
    if (match) {
      const replacement = action.redirect.regexSubstitution.replace(/\\([0-9\\])/g, (_token, group: string) =>
        group === "\\" ? "\\" : match[Number(group)] ?? "",
      );
      target = requestUrl.slice(0, match.index) + replacement + requestUrl.slice(match.index + match[0].length);
    }
  }
  if (!target || target === requestUrl) return null;
  try {
    return new URL(target).protocol === "javascript:" ? null : target;
  } catch {
    return null;
  }
}

export function checkDeclarativeNetRequest(
  registry: RivetRegistry,
  requestUrl: string,
  initiatorUrl?: string,
  resourceType?: string,
): DNRDecision | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  let initiatorHost = "";
  try {
    if (initiatorUrl) initiatorHost = new URL(initiatorUrl).hostname;
  } catch {
  }
  let redirect: { url: string; installedAt: number } | undefined;
  const headerRules: { ext: ExtensionState; rules: CompiledRule[] }[] = [];
  for (const ext of registry.extensions.values()) {
    if (!ext.enabled) continue;
    const headers: CompiledRule[] = [];
    let candidate = false;
    let allowPriority = -Infinity;
    for (const compiled of getRules(ext)) {
      const { rule } = compiled;
      const action = rule.action;
      if (candidate && action.type !== "modifyHeaders") continue;
      if (!ruleMatches(compiled, requestUrl, url, initiatorHost, resourceType)) continue;
      if (action.type === "modifyHeaders") {
        if ((rule.priority ?? 1) > allowPriority) headers.push(compiled);
        continue;
      }
      if (action.type === "allow") {
        allowPriority = rule.priority ?? 1;
        candidate = true;
      } else if (action.type === "block") {
        return { action: "block" };
      } else {
        const redirectUrl = getRedirectUrl(compiled, requestUrl, url);
        if (!redirectUrl) continue;
        candidate = true;
        if (!redirect || ext.installedAt > redirect.installedAt) redirect = { url: redirectUrl, installedAt: ext.installedAt };
      }
    }
    if (headers.length) headerRules.push({ ext, rules: headers });
  }
  if (redirect) return { action: "redirect", url: redirect.url };
  if (!headerRules.length) return null;
  const headers: HeaderOperation[] = [];
  const responseHeaders: HeaderOperation[] = [];
  const requestApplied = new Map<string, { operation: string; extId: string }>();
  const responseApplied = new Map<string, { operation: string; extId: string }>();
  headerRules.sort((a, b) => b.ext.installedAt - a.ext.installedAt);
  for (const { ext, rules } of headerRules) {
    for (const { rule } of rules) {
      mergeHeaders(headers, requestApplied, rule.action.requestHeaders, ext.id);
      mergeHeaders(responseHeaders, responseApplied, rule.action.responseHeaders, ext.id);
    }
  }
  return headers.length || responseHeaders.length ? { action: "modifyHeaders", headers, responseHeaders } : null;
}
