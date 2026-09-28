import { negativeMessage } from "../runtime/messages.ts";
import type { RivetHostBindings } from "../../../packages/rivet/src/types";

export const resolveRivetDns: NonNullable<
  RivetHostBindings["resolveDns"]
> = async (hostname, flags) => {
  try {
    if (
      typeof hostname !== "string" ||
      !Array.isArray(flags) ||
      flags.some((flag) => typeof flag !== "string")
    ) {
      throw new Error(negativeMessage("dns query is invalid"));
    }
    const params = new URLSearchParams({ hostname });
    for (const flag of flags) params.append("flag", flag);
    const response = await fetch(`/api/dns?${params}`, {
      headers: { "x-rivet-dns": "1" },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(negativeMessage("dns lookup failed"));
    const result = await response.json();
    if (
      !Array.isArray(result.addresses) ||
      !result.addresses.length ||
      result.addresses.some(
        (address: unknown) => typeof address !== "string",
      ) ||
      typeof result.isTRR !== "boolean" ||
      (result.canonicalName !== undefined &&
        typeof result.canonicalName !== "string")
    ) {
      throw new Error(negativeMessage("dns response is invalid"));
    }
    return result;
  } catch {
    throw new Error(negativeMessage("dns lookup failed"));
  }
};
