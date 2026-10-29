import { iswindow } from "@client/entry";
import { FolioClient } from "@client/index";
import { shouldBypassFingerprintPatches } from "@client/compat";
import { Object_setPrototypeOf, _Map } from "@/shared/snapshot";

export default function (client: FolioClient, self: any) {
	if (iswindow) hideServiceWorkers(client, self);
	if (shouldBypassFingerprintPatches(client)) return;

	const del = (name: string) => {
		const split = name.split(".");
		const prop = split.pop();
		const target = split.reduce((a, b) => a?.[b], self);
		if (!target) return;
		if (prop && prop in target) {
			delete target[prop];
		} else {
		}
	};

	del("BarcodeDetector");
	del("FaceDetector");
	del("TextDetector");

	if (iswindow) {
		del("ServiceWorkerRegistration.prototype.sync");
	}

	del("Navigator.prototype.joinAdInterestGroup");

	if (!iswindow) return;

	del("MediaDevices.prototype.setCaptureHandleConfig");

	del("Navigator.prototype.bluetooth");
	del("Bluetooth");
	del("BluetoothDevice");
	del("BluetoothRemoteGATTServer");
	del("BluetoothRemoteGATTCharacteristic");
	del("BluetoothRemoteGATTDescriptor");
	del("BluetoothUUID");

	del("Navigator.prototype.contacts");
	del("ContactAddress");
	del("ContactManager");

	del("IdleDetector");

	del("Navigator.prototype.presentation");
	del("Presentation");
	del("PresentationConnection");
	del("PresentationReceiver");
	del("PresentationRequest");
	del("PresentationAvailability");
	del("PresentationConnectionAvailableEvent");
	del("PresentationConnectionCloseEvent");
	del("PresentationConnectionList");

	del("WindowControlsOverlay");
	del("WindowControlsOverlayGeometryChangeEvent");
	del("Navigator.prototype.windowControlsOverlay");

	del("Navigator.prototype.hid");
	del("HID");
	del("HIDDevice");
	del("HIDConnectionEvent");
	del("HIDInputReportEvent");
}

function hideServiceWorkers(client: FolioClient, self: any) {
	const Container = self.ServiceWorkerContainer;
	if (!Container || !("serviceWorker" in self.Navigator.prototype)) return;

	const container = new self.EventTarget();
	Object_setPrototypeOf(container, Container.prototype);
	const ready = new self.Promise(() => {});
	const handlers = new _Map<string, unknown>();
	const isFake = (that: unknown) => that === container;

	client.Trap("Navigator.prototype.serviceWorker", {
		get() {
			return container;
		},
	});

	client.Trap("ServiceWorkerContainer.prototype.controller", {
		get(ctx) {
			return isFake(ctx.this) ? null : ctx.get();
		},
	});

	client.Trap("ServiceWorkerContainer.prototype.ready", {
		get(ctx) {
			return isFake(ctx.this) ? ready : ctx.get();
		},
	});

	for (const handler of ["oncontrollerchange", "onmessage", "onmessageerror"]) {
		client.Trap(`ServiceWorkerContainer.prototype.${handler}`, {
			get(ctx) {
				return isFake(ctx.this) ? (handlers.get(handler) ?? null) : ctx.get();
			},
			set(ctx, value) {
				if (!isFake(ctx.this)) return ctx.set(value);
				handlers.set(
					handler,
					typeof value === "function" || typeof value === "object"
						? value
						: null
				);
			},
		});
	}

	client.Proxy("ServiceWorkerContainer.prototype.register", {
		apply(ctx) {
			if (!isFake(ctx.this)) return;
			ctx.return(
				self.Promise.reject(
					new self.DOMException(
						"Failed to register a ServiceWorker: The user denied permission to use Service Worker.",
						"SecurityError"
					)
				)
			);
		},
	});

	client.Proxy("ServiceWorkerContainer.prototype.getRegistration", {
		apply(ctx) {
			if (isFake(ctx.this)) ctx.return(self.Promise.resolve(undefined));
		},
	});

	client.Proxy("ServiceWorkerContainer.prototype.getRegistrations", {
		apply(ctx) {
			if (isFake(ctx.this)) ctx.return(self.Promise.resolve(new self.Array()));
		},
	});

	client.Proxy("ServiceWorkerContainer.prototype.startMessages", {
		apply(ctx) {
			if (isFake(ctx.this)) ctx.return(undefined);
		},
	});
}
