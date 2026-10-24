import type { DNRDecision, DNRRule } from "./types";
import type { ExtensionState, RivetRegistry } from "./registry";

interface CompiledRule {
  rule: DNRRule;
  order: number;
  filter: RegExp | null | undefined;
  domainAnchor: boolean;
  requestDomains: Set<string> | undefined;
  excludedRequestDomains: Set<string> | undefined;
  initiatorDomains: Set<string> | undefined;
  excludedInitiatorDomains: Set<string> | undefined;
}

interface RuleIndex {
  dynamic: DNRRule[];
  session: DNRRule[];
  static: DNRRule[];
  rules: CompiledRule[];
  generic: CompiledRule[];
  byHost: Map<string, CompiledRule[]>;
  hasResponseHeaders: boolean;
}

const ruleIndexes = new WeakMap<ExtensionState, RuleIndex>();
const actionPriority = {
  allow: 4,
  block: 3,
  upgradeScheme: 2,
  redirect: 1,
  modifyHeaders: 0,
};
const ANCHORED_HOST = /^\|\|([a-z0-9.-]+)[\^/:|]/i;
const INDEXABLE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const PLAIN_HOST = /^[a-z0-9.-]*$/;

export function recomputeStaticRules(ext: ExtensionState): void {
  ext.staticRules = [];
  for (const id of ext.enabledRulesetIds) {
    const rules = ext.rulesetRules.get(id);
    if (rules) for (const rule of rules) ext.staticRules.push(rule);
  }
}

function compileFilter(compiled: CompiledRule): void {
  const condition = compiled.rule.condition;
  let pattern = condition.regexFilter ?? "";
  const domainAnchor =
    !condition.regexFilter && Boolean(condition.urlFilter?.startsWith("||"));
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
    pattern =
      left +
      source.replace(/[.*+?^$(){}|[\]\\]/g, (char) => {
        if (char === "*") return ".*";
        if (char === "^") return "(?:[^a-zA-Z0-9_.%\\-]|$)";
        return "\\" + char;
      }) +
      right;
  }
  compiled.domainAnchor = domainAnchor;
  try {
    compiled.filter = new RegExp(
      pattern,
      condition.isUrlFilterCaseSensitive ? "" : "i",
    );
  } catch {
    compiled.filter = null;
  }
}

function lowerDomains(domains: string[] | undefined): Set<string> | undefined {
  return domains?.length
    ? new Set(domains.map((domain) => domain.toLowerCase()))
    : undefined;
}

function indexHosts(compiled: CompiledRule): Iterable<string> | null {
  if (compiled.requestDomains) return compiled.requestDomains;
  const condition = compiled.rule.condition;
  if (condition.regexFilter) return null;
  const host = ANCHORED_HOST.exec(condition.urlFilter ?? "")?.[1]?.toLowerCase();
  return host && INDEXABLE_HOST.test(host) ? [host] : null;
}

function getRuleIndex(ext: ExtensionState): RuleIndex {
  const cached = ruleIndexes.get(ext);
  if (
    cached?.dynamic === ext.dynamicRules &&
    cached.session === ext.sessionRules &&
    cached.static === ext.staticRules
  ) {
    return cached;
  }
  const rules = [...ext.dynamicRules, ...ext.sessionRules, ...ext.staticRules]
    .sort(
      (a, b) =>
        (b.priority ?? 1) - (a.priority ?? 1) ||
        actionPriority[b.action.type] - actionPriority[a.action.type],
    )
    .map(
      (rule, order): CompiledRule => ({
        rule,
        order,
        filter: undefined,
        domainAnchor: false,
        requestDomains: lowerDomains(rule.condition.requestDomains),
        excludedRequestDomains: lowerDomains(
          rule.condition.excludedRequestDomains,
        ),
        initiatorDomains: lowerDomains(rule.condition.initiatorDomains),
        excludedInitiatorDomains: lowerDomains(
          rule.condition.excludedInitiatorDomains,
        ),
      }),
    );
  const generic: CompiledRule[] = [];
  const byHost = new Map<string, CompiledRule[]>();
  for (const compiled of rules) {
    const hosts = indexHosts(compiled);
    if (!hosts) {
      generic.push(compiled);
      continue;
    }
    for (const host of hosts) {
      const bucket = byHost.get(host);
      if (bucket) bucket.push(compiled);
      else byHost.set(host, [compiled]);
    }
  }
  const index: RuleIndex = {
    dynamic: ext.dynamicRules,
    session: ext.sessionRules,
    static: ext.staticRules,
    rules,
    generic,
    byHost,
    hasResponseHeaders: rules.some(
      ({ rule }) =>
        rule.action.type === "modifyHeaders" &&
        Boolean(rule.action.responseHeaders?.length),
    ),
  };
  ruleIndexes.set(ext, index);
  return index;
}

function mergeByOrder(
  left: CompiledRule[],
  right: CompiledRule[],
): CompiledRule[] {
  if (!left.length) return right;
  const merged: CompiledRule[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    merged.push(left[i]!.order < right[j]!.order ? left[i++]! : right[j++]!);
  }
  while (i < left.length) merged.push(left[i++]!);
  while (j < right.length) merged.push(right[j++]!);
  return merged;
}

function candidateRules(index: RuleIndex, hostname: string): CompiledRule[] {
  if (!index.byHost.size) return index.generic;
  if (!PLAIN_HOST.test(hostname)) return index.rules;
  let hits: CompiledRule[] | undefined;
  let combined = false;
  for (let start = 0; ; ) {
    const bucket = index.byHost.get(start ? hostname.slice(start) : hostname);
    if (bucket) {
      combined = hits !== undefined;
      hits = hits ? hits.concat(bucket) : bucket;
    }
    const dot = hostname.indexOf(".", start);
    if (dot === -1) break;
    start = dot + 1;
  }
  if (!hits) return index.generic;
  if (combined) {
    hits = hits
      .sort((a, b) => a.order - b.order)
      .filter((rule, i, sorted) => rule !== sorted[i - 1]);
  }
  return mergeByOrder(index.generic, hits);
}

export function hasDeclarativeNetRequestRules(
  registry: RivetRegistry,
  responseOnly = false,
): boolean {
  for (const ext of registry.extensions.values()) {
    if (
      !ext.enabled ||
      !(
        ext.dynamicRules.length ||
        ext.sessionRules.length ||
        ext.staticRules.length
      )
    )
      continue;
    if (!responseOnly || getRuleIndex(ext).hasResponseHeaders) return true;
  }
  return false;
}

function matchesDomains(
  host: string,
  domains: Set<string> | undefined,
): boolean {
  if (!host || !domains) return false;
  for (let start = 0; ; ) {
    if (domains.has(start ? host.slice(start) : host)) return true;
    const dot = host.indexOf(".", start);
    if (dot === -1) return false;
    start = dot + 1;
  }
}

function ruleMatches(
  compiled: CompiledRule,
  requestUrl: string,
  url: URL,
  initiatorHost: string,
  resourceType?: string,
): boolean {
  const condition = compiled.rule.condition;
  if (
    condition.resourceTypes?.length &&
    (!resourceType || !condition.resourceTypes.includes(resourceType))
  )
    return false;
  if (resourceType && condition.excludedResourceTypes?.includes(resourceType))
    return false;
  if (
    compiled.requestDomains &&
    !matchesDomains(url.hostname, compiled.requestDomains)
  )
    return false;
  if (matchesDomains(url.hostname, compiled.excludedRequestDomains))
    return false;
  if (
    compiled.initiatorDomains &&
    !matchesDomains(initiatorHost, compiled.initiatorDomains)
  )
    return false;
  if (matchesDomains(initiatorHost, compiled.excludedInitiatorDomains))
    return false;
  if (compiled.filter === undefined) compileFilter(compiled);
  return Boolean(
    compiled.filter?.test(
      compiled.domainAnchor ? url.host + url.pathname + url.search : requestUrl,
    ),
  );
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
    if (
      typeof op.header !== "string" ||
      !["append", "set", "remove"].includes(op.operation)
    )
      continue;
    const name = op.header.toLowerCase();
    const previous = applied.get(name);
    if (
      previous &&
      (op.operation !== "append" ||
        previous.operation === "remove" ||
        (previous.operation === "set" && previous.extId !== extId))
    )
      continue;
    if (!previous) applied.set(name, { operation: op.operation, extId });
    target.push({ ...op });
  }
}

function getRedirectUrl(
  compiled: CompiledRule,
  requestUrl: string,
  url: URL,
): string | null {
  const { rule, filter } = compiled;
  const action = rule.action;
  let target = action.redirect?.url;
  if (action.type === "upgradeScheme") {
    if (url.protocol !== "http:" && url.protocol !== "ftp:") return null;
    target = requestUrl.replace(/^(?:http|ftp):/, "https:");
  } else if (
    action.redirect?.regexSubstitution &&
    rule.condition.regexFilter &&
    filter
  ) {
    const match = filter.exec(requestUrl);
    if (match) {
      const replacement = action.redirect.regexSubstitution.replace(
        /\\([0-9\\])/g,
        (_token, group: string) =>
          group === "\\" ? "\\" : (match[Number(group)] ?? ""),
      );
      target =
        requestUrl.slice(0, match.index) +
        replacement +
        requestUrl.slice(match.index + match[0].length);
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
  responseOnly = false,
): DNRDecision | null {
  if (!hasDeclarativeNetRequestRules(registry, responseOnly)) return null;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  let initiatorHost = "";
  try {
    if (initiatorUrl) initiatorHost = new URL(initiatorUrl).hostname;
  } catch {}
  let redirect: { url: string; installedAt: number } | undefined;
  const headerRules: { ext: ExtensionState; rules: CompiledRule[] }[] = [];
  for (const ext of registry.extensions.values()) {
    if (!ext.enabled) continue;
    const headers: CompiledRule[] = [];
    let candidate = false;
    let allowPriority = -Infinity;
    for (const compiled of candidateRules(getRuleIndex(ext), url.hostname)) {
      const { rule } = compiled;
      const action = rule.action;
      if (candidate && action.type !== "modifyHeaders") continue;
      if (!ruleMatches(compiled, requestUrl, url, initiatorHost, resourceType))
        continue;
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
        if (!redirect || ext.installedAt > redirect.installedAt)
          redirect = { url: redirectUrl, installedAt: ext.installedAt };
      }
    }
    if (headers.length) headerRules.push({ ext, rules: headers });
  }
  if (redirect) return { action: "redirect", url: redirect.url };
  if (!headerRules.length) return null;
  const headers: HeaderOperation[] = [];
  const responseHeaders: HeaderOperation[] = [];
  const requestApplied = new Map<
    string,
    { operation: string; extId: string }
  >();
  const responseApplied = new Map<
    string,
    { operation: string; extId: string }
  >();
  headerRules.sort((a, b) => b.ext.installedAt - a.ext.installedAt);
  for (const { ext, rules } of headerRules) {
    for (const { rule } of rules) {
      if (!responseOnly)
        mergeHeaders(
          headers,
          requestApplied,
          rule.action.requestHeaders,
          ext.id,
        );
      mergeHeaders(
        responseHeaders,
        responseApplied,
        rule.action.responseHeaders,
        ext.id,
      );
    }
  }
  return headers.length || responseHeaders.length
    ? { action: "modifyHeaders", headers, responseHeaders }
    : null;
}
