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

export type LocalMaskAddressValuePair = {
    address : number;
    masking : boolean;
    value   : number;
}

export type MaskUniverseData = {
    mask : BitSet;
    data : Buffer;
}

export type Patch = {
    inputUniverse  : number;
    outputUniverse : number;
    maskUniverse   : number;
}

export type MaskValue = {
    value   : number;
    masking : boolean;
}

enum PortType {
    Output = 0x00,
    Input  = 0x01
}

export type Port = {
    universe : number;
    mode     : PortType;
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

    setFramerate(framerate : number) {
        const body = Buffer.allocUnsafe(1);
        body.writeUInt8(framerate, 0);

        this.sendMessage(0x0005, body);
    }

    getFramerate(timeout : number = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise((resolve) => {
            this.clearResponse();

            this.onData((data) => {
                if (data.length >= 1) {
                    resolve(data.readUInt8(0));
                }
            });

            this.sendMessage(0x0006);
        }), timeout);
    }

    createMaskUniverse(universe : number) {
        const body = Buffer.allocUnsafe(2);
        body.writeUInt16LE(universe, 0);

        this.sendMessage(0x0007, body);
    }

    getMaskUniverses(timeout : number = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise<number[]>((resolve) => {
            this.clearResponse();

            let universeCount = 0;

            this.onData((data) => {
                if (data.length >= 2) {
                    universeCount = data.readUInt16LE(0);
                }

                if (data.length >= 2 + (universeCount * 2)) {
                    const universes : number[] = [];

                    for (let i = 0; i < universeCount; ++i) {
                        const offset = 2 + i * 2;

                        universes.push(data.readUInt16LE(offset));
                    }

                    resolve(universes);
                }
            });

            this.sendMessage(0x0008);
        }), timeout);
    }

    deleteMaskUniverse(universe : number) {
        const body = Buffer.allocUnsafe(2);
        body.writeUInt16LE(universe, 0);

        this.sendMessage(0x0009, body);
    }

    setMaskUniverseData(universe : number, data : MaskUniverseData) {
        const body = data.data.length === 512 ? Buffer.allocUnsafe(2 + 64 + 512) : Buffer.alloc(2 + 64 + 512);
        body.writeUInt16LE(universe, 0);
        bitsetToBuffer(body, data.mask, 64, 2);
        data.data.copy(body, 2 + 64);

        this.sendMessage(0x000A, body);
    }

    setMaskAddressValues(universe : number, pairs : LocalMaskAddressValuePair[]) {
        const body = Buffer.allocUnsafe(2 + (pairs.length * 4));
        body.writeUInt16LE(universe, 0);

        pairs.forEach((pair : LocalMaskAddressValuePair, index : number) => {
            const offset = 2 + (index * 4);

            body.writeUInt16LE(pair.address, offset);
            body.writeUInt8(pair.masking ? 1 : 0, offset + 2);
            body.writeUInt8(pair.value, offset + 3);
        });

        this.sendMessage(0x000B, body);
    }

    getMaskUniverseData(universe : number, timeout : number = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise<MaskUniverseData>((resolve) => {
            this.clearResponse();

            this.onData((data) => {
                if (data.length >= 64 + 512) {
                    resolve({
                        mask: bufferToBitset(data, 64),
                        data: data.subarray(64, 64 + 512)
                    });
                }
            });

            const body = Buffer.allocUnsafe(2);
            body.writeUInt16LE(universe, 0);

            this.sendMessage(0x000C, body);
        }), timeout);
    }

    clearMaskUniverse(universe : number) {
        const body = Buffer.allocUnsafe(2);
        body.writeUInt16LE(universe, 0);

        this.sendMessage(0x000D, body);
    }

    patch(patch : Patch) {
        const body = Buffer.allocUnsafe(6);
        body.writeUInt16LE(patch.inputUniverse,  0);
        body.writeUInt16LE(patch.outputUniverse, 2);
        body.writeUInt16LE(patch.maskUniverse,   4);

        this.sendMessage(0x000E, body);
    }

    unpatch(outputUniverse : number) {
        const body = Buffer.allocUnsafe(2);
        body.writeUInt16LE(outputUniverse, 0);

        this.sendMessage(0x000F, body);
    }

    getPatches(timeout : number = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise<Patch[]>((resolve) => {
            this.clearResponse();

            let patchCount = 0;

            this.onData((data) => {
                if (data.length >= 2) {
                    patchCount = data.readUInt16LE(0);
                }

                if (data.length >= 2 + (patchCount * 6)) {
                    const patches : Patch[] = [];

                    for (let i = 0; i < patchCount; ++i) {
                        const offset = 2 + i * 6;

                        patches.push({
                            outputUniverse: data.readUInt16LE(offset),
                            inputUniverse: data.readUInt16LE(offset + 2),
                            maskUniverse: data.readUInt16LE(offset + 4)
                        });
                    }

                    resolve(patches);
                }
            });

            this.sendMessage(0x0010);
        }), timeout);
    }

    copyUniverse(sourceUniverse : number, destinationUniverse : number) {
        const body = Buffer.allocUnsafe(4);
        body.writeUInt16LE(sourceUniverse,  0);
        body.writeUInt16LE(destinationUniverse, 2);

        this.sendMessage(0x0011, body);
    }

    setAddressesToValue(universe : number, value : number, mask : ReadOnlyBitSet) {
        const body = Buffer.allocUnsafe(2 + 1 + 64);
        body.writeUInt16LE(universe, 0);
        body.writeUInt8(value, 2);
        bitsetToBuffer(body, mask, 64, 3);

        this.sendMessage(0x0012, body);
    }

    setMaskAddressesToValue(universe : number, value : number, mask : ReadOnlyBitSet) {
        const body = Buffer.allocUnsafe(2 + 1 + 64);
        body.writeUInt16LE(universe, 0);
        body.writeUInt8(value, 2);
        bitsetToBuffer(body, mask, 64, 3);

        this.sendMessage(0x0012, body);
    }

    listPorts(timeout : number = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise<Port[]>((resolve) => {
            this.clearResponse();

            let portCount = 0;

            this.onData((data) => {
                if (data.length >= 2) {
                    portCount = data.readUInt16LE(0);
                }

                if (data.length >= 2 + (portCount * 3)) {
                    const ports : Port[] = [];

                    for (let i = 0; i < portCount; ++i) {
                        const offset = 2 + i * 3;

                        ports.push({
                            universe: data.readUInt16LE(offset),
                            mode: data.readUInt8(offset + 2)
                        });
                    }

                    resolve(ports);
                }
            });

            this.sendMessage(0x0010);
        }), timeout);
    }

    getValuesByAddress(addresses : AddressPack[], timeout : number = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise<number[]>((resolve) => {
            this.clearResponse();

            this.onData((data) => {
                if (data.length >= addresses.length) {
                    resolve(Array.from<number>(data));
                }
            });

            const body = Buffer.allocUnsafe(addresses.length * 4);

            addresses.forEach((address, index) => {
                const offset = index * 4;

                body.writeUInt16LE(address.universe, offset);
                body.writeUInt16LE(address.address, offset + 2);
            });

            this.sendMessage(0x0010);
        }), timeout);
    }

    getMaskValuesByAddress(addresses : AddressPack[], timeout : number = Device.DEFAULT_TIMEOUT) {
        return functionTimeout(new Promise<MaskValue[]>((resolve) => {
            this.clearResponse();

            this.onData((data) => {
                if (data.length >= addresses.length * 2) {
                    const values : MaskValue[] = [];

                    for (let i = 0; i < addresses.length; ++i) {
                        const offset = i * 2;

                        values.push({
                            value: data.readUInt8(offset),
                            masking: data.readUInt8(offset + 1) > 0
                        });
                    }

                    resolve(values);
                }
            });

            const body = Buffer.allocUnsafe(addresses.length * 4);

            addresses.forEach((address, index) => {
                const offset = index * 4;

                body.writeUInt16LE(address.universe, offset);
                body.writeUInt16LE(address.address, offset + 2);
            });

            this.sendMessage(0x0010);
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
