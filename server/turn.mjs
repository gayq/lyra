export function turnConfig(host, env = process.env) {
  if (env.WEBRTC_TURN_ENABLED === "0") {
    return { enabled: false, forceRelay: false, iceServers: [] };
  }
  const relayHost = env.TURN_HOST || host;
  const port = env.TURN_PORT || "3478";
  return {
    enabled: true,
    forceRelay: env.WEBRTC_FORCE_RELAY !== "0",
    iceServers: [
      {
        urls: [
          `turn:${relayHost}:${port}?transport=udp`,
          `turn:${relayHost}:${port}?transport=tcp`,
        ],
        username: env.TURN_USERNAME || "lyly",
        credential: env.TURN_CREDENTIAL || "rara",
      },
    ],
  };
}
