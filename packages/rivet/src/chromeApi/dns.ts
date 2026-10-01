import { negativeMessage } from "../messages";
import type { ChromeApiContext } from "./context";
import { cloneForRealm } from "./common";

export function createDnsApi({ realm, ext, host }: ChromeApiContext) {
  if (!host.resolveDns) return undefined;
  return {
    async resolve(hostname: string, flags: string[] = []) {
      if (!ext.grantedPermissions.has("dns")) {
        throw new Error(negativeMessage("dns permission is required"));
      }
      try {
        return cloneForRealm(realm, await host.resolveDns!(hostname, flags));
      } catch {
        throw new Error(negativeMessage("dns lookup failed"));
      }
    },
  };
}
