import {SerialPort} from "serialport";
import {BitSet, ReadOnlyBitSet} from "bitset";

const bitsetToBuffer = (destination : Buffer, source : ReadOnlyBitSet, byteCount : number, offset : number = 0) => {
    if (offset + byteCount > destination.length) {
        throw "buffer overflow";
    }

    for (let i = 0; i < byteCount; ++i) {
        const bitsetOffset = i * 8;
        const bufferOffset = offset + i;

        destination.writeUInt8(
            0
            | (source.get(bitsetOffset) * 0b10000000)
            | (source.get(bitsetOffset + 1) * 0b01000000)
            | (source.get(bitsetOffset + 2) * 0b00100000)
            | (source.get(bitsetOffset + 3) * 0b00010000)
            | (source.get(bitsetOffset + 4) * 0b00001000)
            | (source.get(bitsetOffset + 5) * 0b00000100)
            | (source.get(bitsetOffset + 6) * 0b00000010)
            | (source.get(bitsetOffset + 7) * 0b00000001),
            bufferOffset
        );
    }
};

const bufferToBitset = (source : Buffer, byteCount : number, offset : number = 0) : BitSet => {
    if (offset + byteCount > source.length) {
        throw "buffer overflow";
    }

    const set = new BitSet();

    for (let i = 0; i < byteCount; ++i) {
        const bitsetOffset = i * 8;
        const bufferOffset = offset + i;

        const byte = source.readUInt8(bufferOffset);

        set.set(bitsetOffset, byte & 0b10000000);
        set.set(bitsetOffset + 1, byte & 0b01000000);
        set.set(bitsetOffset + 2, byte & 0b00100000);
        set.set(bitsetOffset + 3, byte & 0b00010000);
        set.set(bitsetOffset + 4, byte & 0b00001000);
        set.set(bitsetOffset + 5, byte & 0b00000100);
        set.set(bitsetOffset + 6, byte & 0b00000010);
        set.set(bitsetOffset + 7, byte & 0b00000001);
    }

    return set;
};

export const listSerialPorts = () : Promise<string[]> => SerialPort.list()
    .then((ports) => ports.map((port) => port.path));

export const functionTimeout = (func : Function | Promise<any>, timeout = 1000) => new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
        reject("timeout reached");
    }, timeout);

    const result = func instanceof Promise ? func : func();

    if (result instanceof Promise) {
        result.then((value) => {
            clearTimeout(timeoutId);
            resolve(value);
        }).catch((value) => {
            clearTimeout(timeoutId);
            reject(value);
        });
    } else {
        clearTimeout(timeoutId);
        resolve(result);
    }
});

export type DevicePort = {
    port : number;
    mode : string;
}

export type DeviceInfo = {
    version  : string;
    name     : string;
    model    : string;
    ports    : DevicePort[];
    features : string[];
}

export type AddressPack = {
    universe : number;
    address  : number;
}

export type AddressValuePair = {
    address : AddressPack;
    value   : number;
}

export type DataCallback = (data : Buffer) => void;

export class Device {
    static DEFAULT_TIMEOUT = 1000;

    portPath     : string              = "";
    port         : SerialPort | null   = null;
    dcsmVersion  : string              = "";
    name         : string              = "";
    model        : string              = "";
    ports        : DevicePort[]        = [];
    features     : string[]            = [];
    dataCallback : DataCallback | null = null;
    response     : Buffer | null       = null;

    constructor(path : string) {
        this.portPath = path;
    }

    connect(timeout : number = Device.DEFAULT_TIMEOUT) : Promise<void> {
        return new Promise((resolve, reject) => {
            this.port = new SerialPort({
                path: this.portPath,
                baudRate: 115200
            });

            const timeoutId = setTimeout(() => {
                this.port?.close();
                reject("timeout reached");
            }, timeout);

            const error = (message : string) => {
                if (timeout <= 0) {
                    reject(`connection failed: ${message}`);
                }

                setTimeout(() => {
                    this.connect(timeout - 100).then(resolve).catch(reject);
                }, 100);
            };

            this.port.on("error", error);
            this.port.on("open", () => {
                clearTimeout(timeoutId);
                this.port?.on("data", (data) => this.dataReceived(data));
                this.port?.removeListener("error", error);
                resolve();
            });
        });
    }

    private sendMessageHeader(opcode : number, length : number) {
        const header = Buffer.allocUnsafe(5);
        header.writeUInt8(0x00, 0);
        header.writeUInt16LE(opcode, 1);
        header.writeUInt16LE(length, 3);

        this.port?.write(header);
    }

    sendMessage(opcode : number, data : Buffer = Buffer.alloc(0)) {
        this.sendMessageHeader(opcode, data.length);
        this.port?.write(data);
    }

    private clearResponse() {
        this.response = null;
    }

    private populateData(data : DeviceInfo) {
        this.dcsmVersion = data.version;
        this.name = data.name;
        this.model = data.model;

        data.ports?.forEach((port : DevicePort) => {
            this.ports[port.port] = port;
        });

        this.features = data.features;
    }

    private dataReceived(data : Buffer) {
        this.response = this.response ? Buffer.concat([this.response, data]) : data;

        if (this.dataCallback) {
            this.dataCallback(this.response);
        }
    }

    onData(callback : DataCallback) {
        this.dataCallback = callback;
    }

    identify(timeout = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise((resolve, reject) => {
            this.clearResponse();

            this.onData((data) => {
                const response = String(data);

                if (response.endsWith("\n\n")) {
                    let data;

                    try {
                        data = JSON.parse(response);
                    } catch (e) {}

                    if (!data || !data.version) {
                        reject("invalid identify response");
                    }

                    this.populateData(data);
                    resolve(data);
                }
            });

            this.sendMessage(0x0001);
        }), timeout);
    }

    setUniverseData(universe : number, data : Buffer = Buffer.alloc(512, 0x00)) {
        this.clearResponse();

        const bodyUniverse = Buffer.allocUnsafe(2);
        bodyUniverse.writeUInt16LE(universe, 0);

        this.sendMessage(0x0002, Buffer.concat([ bodyUniverse, data ]));
    }

    setAddressValues(pairs : AddressValuePair[]) {
        const body = Buffer.allocUnsafe(pairs.length * 5);

        for (let i = 0; i < pairs.length; ++i) {
            const pair = pairs[i];
            const offset = i * 5;

            body.writeUInt16LE(pair.address.universe, offset);
            body.writeUInt16LE(pair.address.address,  offset + 2);
            body.writeUInt8   (pair.value,            offset + 4);
        }

        this.clearResponse();

        this.sendMessage(0x0003, body);
    }

    getUniverseData(universe : number, timeout = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise((resolve) => {
            this.clearResponse();

            this.onData((data) => {
                if (data.length >= 512) {
                    resolve(data);
                }
            });

            const body = Buffer.allocUnsafe(2);
            body.writeUInt16LE(universe, 0);

            this.sendMessage(0x0004, body);
        }), timeout);
    }
}

export const connectDevices = () => new Promise<Device[]>((resolve, reject) => {
    const devices : Device[] = [];

    listSerialPorts().then((ports) => {
        const testDevice = (paths : string[], index : number) => {
            if (index === paths.length) {
                resolve(devices);
                return;
            }

            const path = paths[index];

            const device = new Device(path);

            device.connect()
                .then(() => {
                    device.identify().then(() => {
                        console.log(`DCSM device (${path}) found.`);
                        devices.push(device);
                        testDevice(paths, ++index);
                    }).catch((message : string) => {
                        console.log(`Device (${path}) rejected: ${message}.`);
                        testDevice(paths, ++index);
                    });
                })
                .catch((message : string) => {
                    console.log(`Device (${path}) rejected: ${message}.`);
                    testDevice(paths, ++index);
                });
        };

        testDevice(ports, 0);
    }).catch(() => reject("cannot find devices"));
});
