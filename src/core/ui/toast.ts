import { formatRuntimeMessage } from "../runtime/messages.ts";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastAction {
  text: string;
  class?: string;
  dismiss?: boolean;
  callback?: () => void;
}

export interface ToastController {
  id: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startTime: number | null;
  pause(): void;
  start(): void;
  clear(): void;
  hide(): void;
  update(
    newType?: ToastType | string,
    newMessage?: string,
    newIcon?: string,
  ): void;
}

declare global {
  interface Window {
    showToast?: (
      type: ToastType | string,
      message: string,
      iconName?: string,
      arg4?: number | ToastAction[],
      arg5?: ToastAction[],
    ) => ToastController;
  }
}

const DEFAULT_ICON_BY_TYPE: Record<ToastType, string> = {
  success: "IconCheckCircle2",
  error: "IconExclamationTriangle",
  info: "IconCircleInfo",
  warning: "IconExclamationTriangle",
};


export function normalizeToastType(type: string): ToastType {
  if (
    type === "success" ||
    type === "error" ||
    type === "info" ||
    type === "warning"
  ) {
    return type;
  }
  return "info";
}

export function resolveToastIcon(type: string, iconName?: string): string {
  const normalizedType = normalizeToastType(type);
  if (!iconName) return DEFAULT_ICON_BY_TYPE[normalizedType];
  return iconName;
}

export function showToast(
  type: ToastType | string,
  message: string,
  iconName?: string,
  durationOrActions?: number | ToastAction[],
  actions?: ToastAction[],
): ToastController | null {
  return (
    window.showToast?.(
      normalizeToastType(type),
      formatRuntimeMessage(type, message),
      resolveToastIcon(type, iconName),
      durationOrActions,
      actions,
    ) ?? null
  );
}

export const toast = {
  show: showToast,
  success(
    message: string,
    iconName?: string,
    duration = 3000,
  ): ToastController | null {
    return showToast("success", message, iconName, duration);
  },
  error(
    message: string,
    iconName?: string,
    duration = 3000,
  ): ToastController | null {
    return showToast("error", message, iconName, duration);
  },
  info(
    message: string,
    iconName?: string,
    duration = 3000,
  ): ToastController | null {
    return showToast("info", message, iconName, duration);
  },
  warning(
    message: string,
    iconName?: string,
    duration = 3000,
  ): ToastController | null {
    return showToast("warning", message, iconName, duration);
  },
};
